import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AuditConfig } from '../load-config';
import { findInjections, resolveInjection } from '../injection-scan';
import type { ResolveContext } from '../injection-scan';
import type { AuditFinding } from '../types';

/**
 * After the doc-injection preprocessor finishes, the resulting prompt is
 * handed to Nunjucks. Anything mustache-shaped that survives the preprocessor
 * is parsed as a Nunjucks expression. There are two failure modes:
 *
 * 1. A literal mustache token in any file that isn't a recognised injection or
 *    a Nunjucks variable. Example: prose like `{{tag-name}}` in a comment
 *    field. Nunjucks chokes with "expected variable end".
 *
 * 2. **An injection-shape token (`{{system-doc:…}}`, `{{shared:…}}`, etc.)
 *    inside a file that is itself reached via injection.** The preprocessor
 *    runs only on the top-level template — see `lib/template/template-engine.
 *    ts::preprocessDocTags` / `extractSystemTags`, each does one pass. An
 *    injection-shape token inside team.json (or any other injected doc) is
 *    pasted through unchanged and then crashes Nunjucks.
 *
 * The team.json outage earlier this session was case 2: team.json's `_comment_`
 * field documented its own injection path with `{{system-doc:team.json}}` as a
 * literal. After expansion, that string ended up in the template body and the
 * render failed.
 */
const INJECTION_PREFIXES = ['doc', 'shared', 'system-doc', 'system-shared'];

// Discriminates "malformed injection" from "Nunjucks variable expression."
// A real injection has the shape `{{<prefix>:<path>}}`. A Nunjucks variable
// expression — `{{ event.ts | default("now") | replace(".","_") }}`,
// `{{ var or 5 }}`, etc. — does NOT contain a `:` between `{{` and `}}`
// (Nunjucks does not use `:` as a syntactic separator at the top level of
// an expression). So any mustache-shaped token that has a top-level `:` and
// is NOT one of the recognised injection prefixes is the failure mode this
// rule exists to catch.
const INJECTION_SHAPED_REGEX = /^\{\{\s*([a-zA-Z][a-zA-Z0-9_-]*)\s*:/;

interface FileToScan {
  readonly displayPath: string;
  readonly source: string;
  /**
   * `template` — the route's messageTemplate. Injection-shape tokens here
   *              get expanded by the preprocessor, so they're allowed.
   * `injected` — a file reached via injection. Injection-shape tokens here
   *              survive to Nunjucks and crash. Treated as errors.
   */
  readonly tier: 'template' | 'injected';
}

export async function checkNoLiteralMustache(
  agentDir: string,
  config: AuditConfig,
  context: ResolveContext,
): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];

  const scanned = new Set<string>();
  for (const routing of Object.values(config.routing)) {
    for (const rule of routing.rules) {
      if (rule.messageTemplate === undefined) continue;
      const templatePath = join(agentDir, rule.messageTemplate);
      if (scanned.has(templatePath)) continue;
      scanned.add(templatePath);

      let source: string;
      try {
        source = await readFile(templatePath, 'utf-8');
      } catch {
        continue;
      }

      const files = await collectReachable(rule.messageTemplate, source, context);
      for (const file of files) {
        scanLine(file, findings);
      }
    }
  }

  return findings;
}

/**
 * Returns the root template plus every file it (transitively) injects. We do
 * recurse here even though the runtime does not, because each injected file
 * still ends up as raw text in the final Nunjucks input — its literal tokens
 * are observable to the parser. Cycles are broken by tracking visited paths.
 */
async function collectReachable(
  rootPath: string,
  rootSource: string,
  context: ResolveContext,
): Promise<FileToScan[]> {
  const visited = new Set<string>();
  const out: FileToScan[] = [{ displayPath: rootPath, source: rootSource, tier: 'template' }];

  async function recurse(source: string): Promise<void> {
    for (const ref of findInjections(source)) {
      const resolution = resolveInjection(ref, context);
      if (!resolution.exists) continue;
      if (visited.has(resolution.absolutePath)) continue;
      visited.add(resolution.absolutePath);
      const nested = await readFile(resolution.absolutePath, 'utf-8');
      out.push({ displayPath: resolution.displayPath, source: nested, tier: 'injected' });
      await recurse(nested);
    }
  }

  await recurse(rootSource);
  return out;
}

function scanLine(file: FileToScan, findings: AuditFinding[]): void {
  const lines = file.source.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    // Linear scan for `{{...}}` tokens — preferred over a regex like
    // /\{\{[^}]*\}\}/g, which Sonar flags as ReDoS-vulnerable even though
    // the [^}]* class can't actually backtrack catastrophically.
    let cursor = 0;
    for (;;) {
      const openIndex = line.indexOf('{{', cursor);
      if (openIndex === -1) break;
      const closeIndex = line.indexOf('}}', openIndex + 2);
      if (closeIndex === -1) break;
      const token = line.slice(openIndex, closeIndex + 2);
      const verdict = classify(token, file.tier);
      cursor = closeIndex + 2;
      if (verdict === 'ok') continue;
      findings.push({
        severity: 'error',
        rule: verdict.rule,
        message: `${file.displayPath} contains \`${token}\` — ${verdict.detail}`,
        path: file.displayPath,
        line: i + 1,
        hint: verdict.hint,
      });
    }
  }
}

interface BadToken {
  readonly rule: string;
  readonly detail: string;
  readonly hint: string;
}

function classify(token: string, tier: FileToScan['tier']): BadToken | 'ok' {
  const prefixMatch = INJECTION_SHAPED_REGEX.exec(token);
  if (prefixMatch === null) {
    // No `<ident>:` head — it's a Nunjucks variable / filter expression.
    // Nunjucks handles malformed expressions at parse time, not the audit's
    // job to relitigate that.
    return 'ok';
  }

  const prefix = prefixMatch[1];
  const recognised =
    prefix !== undefined && (INJECTION_PREFIXES as readonly string[]).includes(prefix);

  if (!recognised) {
    return {
      rule: 'literal-mustache-in-doc',
      detail: `a mustache-shaped token whose prefix \`${prefix ?? ''}:\` is not one of the recognised injection types (${INJECTION_PREFIXES.join(', ')}). The doc-injection preprocessor will leave it untouched and Nunjucks will then try to parse it, which crashes with "expected variable end".`,
      hint: 'Describe the syntax in prose rather than showing a literal example.',
    };
  }

  if (tier === 'template') return 'ok';

  return {
    rule: 'injection-token-in-injected-doc',
    detail:
      'an injection-shape token inside an injected doc. The doc-injection preprocessor runs ONCE on the template body and does NOT recurse into injected content; this token survives to Nunjucks and crashes the render.',
    hint: 'Describe the injection syntax in prose (e.g. "templates inject this file via the system-doc tag") instead of writing a literal example.',
  };
}
