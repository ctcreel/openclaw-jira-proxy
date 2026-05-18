import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

import { load as parseYaml } from 'js-yaml';
import { z } from 'zod';

import { auditAgent } from '../audit';
import { modelRuleSchema } from '../config';
import type { AgentEntry, SharedToolsConfig } from '../config';
import { getLogger } from '../lib/logging';
import { runnerConfigSchema } from '../runners/types';
import { listEmbeddingProviders } from './memory/embedding';
import { agentMemorySchema, ruleMemorySchema } from './memory/config-schemas';
import { listVectorStores } from './memory/vector-store';
import { conditionSchema } from '../strategies/routing';
import { listSessionKeyStrategies, sessionConfigSchema } from '../strategies/session-key';
import { ruleToolsSchema, type ToolRef } from './tools/config-schemas';
import { loadToolDescriptor } from './tools/parse';
import { validateToolSignature } from './tools/validate';
import { getToolCatalog } from './tool-catalog.service';
import { getSecretManager } from '../secrets/manager';

const execFile = promisify(execFileCallback);
const logger = getLogger('agent-loader');

// Per-rule control over which identity-tier docs get auto-injected into
// the system slot. Both default to true; an opt-out shape lets mechanical
// routes (cron health checks, etc.) skip SOUL when the voice/principles
// guidance would just be cache pollution. Anything that's NOT a rule
// definition (e.g. a one-shot scheduled health check that needs neither)
// can set both to false.
const identityInjectionSchema = z
  .object({
    identity: z.boolean().default(true),
    soul: z.boolean().default(true),
  })
  .default({ identity: true, soul: true });

// Rules are shared across providers, but `routing.schedule` rules carry
// extra fields (cron + timezone + catchUp + context) and don't need a
// `condition`. Validating the per-provider invariants — schedule rules
// have a cron, condition rules have a condition — happens in the
// schedulers/workers that consume the rules, not at parse time. This
// keeps the schema flat and the type one shape across providers.
//
// `runner` is consumed today only by the schedule provider's task-worker;
// other providers ignore it. A non-schedule rule with `runner` set parses
// successfully but has no runtime effect — acceptable v1 trade-off
// against splitting the schema per provider.
// Identity slug pattern: starts with a letter, then letters/digits/hyphens
// only. This is the stable identifier that survives `name:` renames and
// keys the sidecar layout file (clawndom.layout.yaml). When omitted, the
// loader defaults it to `kebab-case(name)`. See `resolveRuleId`.
const ruleIdPattern = /^[a-z][a-z0-9-]*$/;

export const agentRuleSchema = z.object({
  /** Stable identifier that survives renames. Defaults to a kebab-slug of
   * `name:` when omitted. Editor write-back / sidecar layout / audit
   * cross-references all use this. */
  id: z
    .string()
    .regex(ruleIdPattern, { message: 'id must be lowercase kebab-case (letters, digits, hyphens)' })
    .optional(),
  name: z.string().optional(),
  condition: conditionSchema.optional(),
  messageTemplate: z.string().optional(),
  cron: z.string().optional(),
  timezone: z.string().optional(),
  catchUp: z.boolean().optional().default(false),
  context: z.record(z.string(), z.unknown()).optional(),
  runner: runnerConfigSchema.optional(),
  /** Opt-in memory binding for this rule. See `memory-aware-agent-runner` capability. */
  memory: ruleMemorySchema.optional(),
  /**
   * Opt-in session-aware runner mode. When present, events matching this
   * rule dispatch through the SessionPool (warm subprocess + Redis-backed
   * session_id resume) instead of the per-event-spawn path. NOT supported
   * on `routing.schedule` rules — each scheduled run is a snapshot.
   */
  session: sessionConfigSchema.optional(),
  /**
   * Per-rule cap on the number of conversation turns the runner allows
   * before terminating the run. Defaults to the runner's built-in 150
   * when omitted; templates that produce wide cascades (e.g. multi-file
   * test-tuple-shape changes — SPE-2010 ate 150 turns of mechanical
   * Edit calls without finishing) opt in to a higher ceiling here.
   * Only honoured by the claude-cli runner today; other runners ignore.
   */
  maxTurns: z.number().int().positive().optional(),
  /**
   * Agent-callable tools available to this rule's runs. Each entry uses
   * `module.python:` with a dotted import-path reference to a Python tool
   * directory containing `tool.yaml` and `impl.py`.
   * See `openspec/changes/spe-2078-tool-use/specs/agent-tool-use/spec.md`.
   * Implemented per SPE-2078; supersedes the reverted SPE-2070 design.
   */
  tools: ruleToolsSchema.optional(),
  /**
   * Auto-injection of agent-identity docs into the system slot. By default,
   * every rule prepends `{{system-doc:identity/IDENTITY.md}}` and
   * `{{system-doc:identity/SOUL.md}}` to the template body before render —
   * so authors don't have to repeat those two lines on every template, and
   * the rule config is the single place that controls which routes need
   * identity/soul context.
   *
   *   identity: { identity: false }   — skip IDENTITY.md (rare).
   *   identity: { soul: false }       — skip SOUL.md (mechanical routes
   *                                     like cron-fired health checks).
   *   identity: { identity: false, soul: false } — bare prompt; the
   *                                     template's full content is what
   *                                     the model sees.
   */
  identity: identityInjectionSchema.optional().default({}),
  /**
   * Internal task types this rule's template dispatches via POST /api/tasks.
   * Makes the cross-rule edge explicit instead of buried in template prose.
   *
   *   dispatches:
   *     - handle-cancellation
   *     - draft-response
   *
   * The audit verifies that the template's curl-to-/api/tasks calls only
   * reference task types in this list, and that each entry corresponds to a
   * `routing.internal` rule somewhere in the configured agents. Empty/omitted
   * = this rule dispatches no internal tasks.
   */
  dispatches: z.array(z.string().min(1)).default([]),
  /**
   * Names of the per-event variables this rule's template expects to receive.
   * For webhook rules these come from the provider's context-extraction
   * strategy; for `routing.internal` rules they come from the dispatch
   * payload posted by the upstream rule. Declared here so the audit can
   * enforce the producer/consumer contract — `{{ messageId }}` in a template
   * with no `messageId` in `inputs:` is a warning.
   *
   *   inputs:
   *     - messageId
   *     - threadId
   *     - from
   *
   * Empty/omitted = the rule doesn't declare its inputs. The audit reports
   * undeclared `{{ var }}` references as informational findings; tightening
   * to errors happens once every rule has declared its inputs.
   */
  inputs: z.array(z.string().min(1)).default([]),
  /**
   * Per-route entity-data-surface scope. When present, this rule's
   * runs receive an `actor` (the resolved entity from the EntityStore)
   * and an injected `{{ entity_model }}` markdown handbook describing
   * the in-scope kinds + their relations. Entity tools called on this
   * route MUST reference a kind listed here; out-of-scope calls are
   * rejected.
   *
   *   entities:
   *     kinds: [client, contact, team_member]
   *
   * See openspec/changes/entities for the substrate spec.
   */
  entities: z
    .object({
      kinds: z.array(z.string().min(1)).min(1),
    })
    .optional(),
  /**
   * Per-route opt-in for cross-surface interaction injection. When
   * present, the template render receives `{{ interactions }}` —
   * recent interactions for the resolved actor (and, with
   * `includeMentionsOfRelatedEntities`, interactions whose --about-->
   * is one of the actor's related clients).
   *
   *   interactions:
   *     topN: 5
   *     includeMentionsOfRelatedEntities: true
   */
  interactions: z
    .object({
      topN: z.number().int().positive().max(50).default(5),
      includeMentionsOfRelatedEntities: z.boolean().default(false),
    })
    .optional(),
});

const agentRoutingSchema = z.object({
  rules: z.array(agentRuleSchema).default([]),
});

export const agentConfigSchema = z.object({
  routing: z.record(z.string(), agentRoutingSchema).default({}),
  modelRules: z.record(z.string(), z.array(modelRuleSchema)).default({}),
  /** Per-agent memory namespaces. Pruning + provider/store binding live here. */
  memory: agentMemorySchema.optional(),
});

export type AgentConfig = z.infer<typeof agentConfigSchema>;
export type AgentRule = z.infer<typeof agentRuleSchema>;

export interface ResolvedAgent {
  readonly name: string;
  readonly dir: string;
  readonly config: AgentConfig;
  /**
   * The `AGENTS_CONFIG` entry this agent was loaded from. Carries the
   * operator-level fields (repo, path, sharedTools, builderBotRef,
   * `operatorAllowlist`, testableMechanism, branchNamingPattern) so
   * downstream callers can enforce Layer-3-style checks without
   * re-walking settings. `undefined` for system agents (Builder)
   * which aren't loaded from `AGENTS_CONFIG`.
   */
  readonly entry?: AgentEntry;
}

export interface GitClient {
  /**
   * Branch-tracking clone. Fast-forwards when no `ref` is supplied; resets to
   * `origin/<ref>` when supplied. Branch semantics — pinned tag/SHA refs go
   * through `clonePinned` instead.
   */
  cloneOrPull(repoUrl: string, cloneDir: string, ref?: string): Promise<void>;
  /**
   * Pinned-ref clone. Fetches all refs (including tags) and resets to the
   * given tag or commit SHA. Throws if the ref does not exist in the remote
   * — fail-fast over silent drift.
   */
  clonePinned(repoUrl: string, cloneDir: string, ref: string): Promise<void>;
}

export const defaultGitClient: GitClient = {
  async cloneOrPull(repoUrl, cloneDir, ref) {
    if (existsSync(cloneDir)) {
      logger.debug({ cloneDir }, 'Fetching latest for agent repo');
      await execFile('git', ['-C', cloneDir, 'fetch', '--prune']);
    } else {
      logger.info({ repoUrl, cloneDir }, 'Cloning agent repo');
      await execFile('git', ['clone', repoUrl, cloneDir]);
    }
    if (ref === undefined) {
      await execFile('git', ['-C', cloneDir, 'pull', '--ff-only']);
    } else {
      await execFile('git', ['-C', cloneDir, 'reset', '--hard', `origin/${ref}`]);
    }
  },

  async clonePinned(repoUrl, cloneDir, ref) {
    if (!existsSync(cloneDir)) {
      logger.info({ repoUrl, cloneDir }, 'Cloning shared-tools repo');
      await execFile('git', ['clone', repoUrl, cloneDir]);
    }
    logger.debug({ cloneDir, ref }, 'Resetting shared-tools repo to pinned ref');
    // No `origin/` prefix: tags and commit SHAs aren't namespaced under
    // remote-tracking refs. `--prune --tags` ensures local tags match the
    // remote so a tag-only ref resolves on reset.
    await execFile('git', ['-C', cloneDir, 'fetch', '--prune', '--tags', 'origin']);
    await execFile('git', ['-C', cloneDir, 'reset', '--hard', ref]);
  },
};

/**
 * Local directory name for a cloned repo. Collision-safe across providers
 * because it includes the org/owner plus the repo name.
 */
export function slugifyRepoUrl(repoUrl: string): string {
  const withoutSuffix = repoUrl.replace(/\.git$/, '');
  const parts = withoutSuffix.split(/[:/]/).filter(Boolean);
  if (parts.length < 2) {
    throw new Error(`Cannot derive clone directory from repo URL: ${repoUrl}`);
  }
  return parts.slice(-2).join('__');
}

export async function loadAgents(
  entries: readonly AgentEntry[],
  configDir: string,
  git: GitClient = defaultGitClient,
): Promise<ResolvedAgent[]> {
  await mkdir(configDir, { recursive: true });

  const cloneByRepo = new Map<string, string>();
  // Tracks which sharedTools spec each agent repo committed to. Two agents
  // sharing an agent repo (e.g. patch + scarlett in `the-agency`) share the
  // same shared-tools clone dir, so they must agree on (repo, ref, path).
  const sharedToolsByRepo = new Map<string, SharedToolsConfig>();
  const resolved: ResolvedAgent[] = [];
  const seenNames = new Set<string>();

  for (const entry of entries) {
    if (seenNames.has(entry.name)) {
      throw new Error(`Duplicate agent name in AGENTS_CONFIG: ${entry.name}`);
    }
    seenNames.add(entry.name);

    let cloneDir = cloneByRepo.get(entry.repo);
    if (cloneDir === undefined) {
      cloneDir = join(configDir, slugifyRepoUrl(entry.repo));
      await git.cloneOrPull(entry.repo, cloneDir, entry.ref);
      cloneByRepo.set(entry.repo, cloneDir);
    }

    if (entry.sharedTools !== undefined) {
      const previous = sharedToolsByRepo.get(entry.repo);
      if (previous === undefined) {
        const sharedDir = join(cloneDir, entry.sharedTools.path);
        await git.clonePinned(entry.sharedTools.repo, sharedDir, entry.sharedTools.ref);
        sharedToolsByRepo.set(entry.repo, entry.sharedTools);
      } else if (
        previous.repo !== entry.sharedTools.repo ||
        previous.ref !== entry.sharedTools.ref ||
        previous.path !== entry.sharedTools.path
      ) {
        throw new Error(
          `Conflicting sharedTools for agent repo ${entry.repo}: ` +
            `previously declared ${JSON.stringify(previous)}, ` +
            `agent ${entry.name} declared ${JSON.stringify(entry.sharedTools)}`,
        );
      }
    }

    const agentDir = entry.path === undefined ? cloneDir : join(cloneDir, entry.path);
    const configPath = join(agentDir, 'clawndom.yaml');
    const rawYaml = await readFile(configPath, 'utf-8');
    const parsed = parseYaml(rawYaml);
    const config = agentConfigSchema.parse(parsed);

    validateMemoryConfig(entry.name, config);
    validateSessionConfig(entry.name, config);
    await validateToolsConfig(entry.name, config, agentDir);
    await runWorkspaceAudit(entry.name, agentDir);

    resolved.push({ name: entry.name, dir: agentDir, config, entry });
  }

  validateMemoryNamespaceUniqueness(resolved);
  return resolved;
}

/**
 * Boot-time workspace audit. Runs the same checks `clawndom-audit` runs at
 * CI time, but against the just-cloned workspace on the operator's machine.
 * Refuses to start an agent whose workspace fails any error-level rule —
 * a broken workspace will produce nothing but failed jobs, so failing fast
 * is strictly better than handing the agent to BullMQ.
 *
 * Warnings (legacy patterns, undeclared scopes) are logged but don't block
 * startup — they're nudges, not crashes.
 */
async function runWorkspaceAudit(agentName: string, agentDir: string): Promise<void> {
  const report = await auditAgent(agentDir);
  const errors = report.findings.filter((finding) => finding.severity === 'error');
  const warnings = report.findings.filter((finding) => finding.severity === 'warning');

  for (const warning of warnings) {
    const location =
      warning.path !== undefined
        ? warning.line !== undefined
          ? ` (${warning.path}:${warning.line})`
          : ` (${warning.path})`
        : '';
    logger.warn(
      { agent: agentName, rule: warning.rule },
      `Workspace audit warning${location}: ${warning.message}`,
    );
  }

  if (errors.length === 0) return;

  const lines = errors.map((error) => {
    const location =
      error.path !== undefined
        ? error.line !== undefined
          ? `${error.path}:${error.line}`
          : error.path
        : '<unknown>';
    return `  - [${error.rule}] ${location}: ${error.message}`;
  });
  throw new Error(
    `Agent ${agentName}: workspace audit failed with ${errors.length} error(s):\n${lines.join('\n')}`,
  );
}

/**
 * Cross-cuts that Zod can't catch on the schema alone:
 *  - Per-rule `memory.namespace` MUST refer to a declared namespace under
 *    the agent's `memory.namespaces` block.
 *  - Each namespace's `embeddingProvider` and `vectorStore` MUST resolve
 *    to a registered Strategy.
 *
 * Throws on first violation with a message naming the offending agent + rule.
 */
function validateMemoryConfig(agentName: string, config: AgentConfig): void {
  const namespaces = config.memory?.namespaces ?? {};
  const knownEmbeddingProviders = new Set(listEmbeddingProviders());
  const knownVectorStores = new Set(listVectorStores());

  for (const [namespaceName, policy] of Object.entries(namespaces)) {
    if (!knownEmbeddingProviders.has(policy.embeddingProvider)) {
      throw new Error(
        `Agent ${agentName}: namespace "${namespaceName}" declares unknown embeddingProvider "${policy.embeddingProvider}". Known: ${Array.from(knownEmbeddingProviders).join(', ') || '<none>'}.`,
      );
    }
    if (!knownVectorStores.has(policy.vectorStore)) {
      throw new Error(
        `Agent ${agentName}: namespace "${namespaceName}" declares unknown vectorStore "${policy.vectorStore}". Known: ${Array.from(knownVectorStores).join(', ') || '<none>'}.`,
      );
    }
  }

  const namespaceNames = new Set(Object.keys(namespaces));
  for (const [providerName, providerRouting] of Object.entries(config.routing)) {
    for (const rule of providerRouting.rules) {
      if (rule.memory === undefined) continue;
      if (!namespaceNames.has(rule.memory.namespace)) {
        const ruleLabel = rule.name ?? '<unnamed>';
        throw new Error(
          `Agent ${agentName}: routing.${providerName} rule "${ruleLabel}" references undeclared memory namespace "${rule.memory.namespace}". Declare it under memory.namespaces.${rule.memory.namespace}.`,
        );
      }
    }
  }
}

/**
 * Cross-cuts that Zod can't catch at parse time:
 *  - `session` is forbidden on `routing.schedule.rules[*]` because each
 *    scheduled run is a snapshot — conversational continuity is meaningless.
 *  - `session.strategy` must reference a registered SessionKeyStrategy.
 *
 * Throws on the first violation with a message identifying the offending
 * agent and rule. Failing fast at startup is preferable to discovering the
 * issue when the first event arrives.
 */
function validateSessionConfig(agentName: string, config: AgentConfig): void {
  const knownStrategies = new Set(listSessionKeyStrategies());
  for (const [providerName, providerRouting] of Object.entries(config.routing)) {
    for (const rule of providerRouting.rules) {
      if (rule.session === undefined) continue;
      const ruleLabel = rule.name ?? '<unnamed>';
      if (providerName === 'schedule') {
        throw new Error(
          `Agent ${agentName}: routing.schedule rule "${ruleLabel}" declares session — schedule rules do not support session-aware runners.`,
        );
      }
      if (!knownStrategies.has(rule.session.strategy)) {
        throw new Error(
          `Agent ${agentName}: routing.${providerName} rule "${ruleLabel}" declares unknown session.strategy "${rule.session.strategy}". Known strategies: ${Array.from(knownStrategies).join(', ') || '<none>'}.`,
        );
      }
    }
  }
}

/**
 * Resolve the default memory namespace for fire-time RAG (SPE-2049).
 * Returns the first declared namespace under `memory.namespaces`, in
 * yaml-declaration order. Agents that opt into `useMemory: true` without
 * naming a namespace get this fallback; agents that don't declare any
 * namespaces get `undefined` and the caller skips RAG gracefully rather
 * than failing the run.
 *
 * Why "first declared" instead of, say, a separate `defaultNamespace`
 * field: it keeps the configuration surface flat. Agents that want a
 * specific default declare that namespace first; agents that don't care
 * (single-namespace agents, the common case) get the obvious behaviour.
 * If we ever need a different default, an explicit field is a forward-
 * compatible addition.
 */
export function getAgentDefaultMemoryNamespace(agent: ResolvedAgent): string | undefined {
  const namespaces = agent.config.memory?.namespaces;
  if (!namespaces) return undefined;
  const keys = Object.keys(namespaces);
  return keys.length > 0 ? keys[0] : undefined;
}

/**
 * Boot-time validation for `routing.<provider>.rules[].tools:` declarations.
 * For each declared tool: resolve the directory, parse `tool.yaml`, and run
 * the signature validator that matches the tool's kind. Also reject duplicate
 * derived tool names within a rule so the Anthropic API registration can't
 * collide.
 *
 * Failing here at boot is the contract that catches YAML↔helper drift before
 * any agent invokes the tool. See
 * `openspec/changes/spe-2078-tool-use/specs/agent-tool-use/spec.md`.
 */
async function validateToolsConfig(
  agentName: string,
  config: AgentConfig,
  agentDir: string,
): Promise<void> {
  for (const [providerName, providerRouting] of Object.entries(config.routing)) {
    for (const rule of providerRouting.rules) {
      const tools: readonly ToolRef[] = rule.tools ?? [];
      if (tools.length === 0) continue;
      const ruleLabel = rule.name ?? '<unnamed>';
      const seenNames = new Set<string>();
      for (const toolRef of tools) {
        let descriptor;
        try {
          descriptor = await loadToolDescriptor(toolRef, agentDir);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(
            `Agent ${agentName}: routing.${providerName} rule "${ruleLabel}": ${message}`,
          );
        }
        if (seenNames.has(descriptor.name)) {
          throw new Error(
            `Agent ${agentName}: routing.${providerName} rule "${ruleLabel}": duplicate tool name '${descriptor.name}' (set explicit 'name:' in tool.yaml to disambiguate)`,
          );
        }
        seenNames.add(descriptor.name);
        getToolCatalog().register(agentName, descriptor);
        try {
          await validateToolSignature(descriptor);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(
            `Agent ${agentName}: routing.${providerName} rule "${ruleLabel}": ${message}`,
          );
        }
        // Fail-fast on missing `secrets:` aliases. Resolution happens
        // per-invocation in load-for-run.ts, but a typo or missing binding
        // would today surface only on the FIRST tool_use — boot is the
        // right place to catch it. For each secret, at least one declared
        // alias MUST be registered in SECRETS_CONFIG.
        const secretManager = getSecretManager();
        for (const secretSpecification of descriptor.secrets) {
          const resolvable = secretSpecification.aliases.some((a) => secretManager.hasSecret(a));
          if (!resolvable) {
            throw new Error(
              `Agent ${agentName}: routing.${providerName} rule "${ruleLabel}": tool '${descriptor.name}' needs secret '${secretSpecification.canonical}' but none of its aliases [${secretSpecification.aliases.join(', ')}] are registered in SECRETS_CONFIG.`,
            );
          }
        }
      }
    }
  }
}

/**
 * Reject cross-agent namespace name collisions. Two agents declaring the
 * same namespace would either fight over pruning policy or accidentally
 * read each other's stored memories (depending on which got registered
 * last). Either is bad; fail at startup.
 */
function validateMemoryNamespaceUniqueness(agents: readonly ResolvedAgent[]): void {
  const seen: Map<string, string> = new Map();
  for (const agent of agents) {
    const namespaces = agent.config.memory?.namespaces ?? {};
    for (const namespaceName of Object.keys(namespaces)) {
      const existing = seen.get(namespaceName);
      if (existing !== undefined && existing !== agent.name) {
        throw new Error(
          `Memory namespace "${namespaceName}" is declared by both agent "${existing}" and agent "${agent.name}". Namespaces must be unique across all agents.`,
        );
      }
      seen.set(namespaceName, agent.name);
    }
  }
}
