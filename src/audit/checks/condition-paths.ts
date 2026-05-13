import { resolveRuleId } from '../../services/rule-id';
import {
  getProviderPayloadSchema,
  resolveArrayItem,
  resolvePath,
  type JsonSchema,
} from '../../strategies/payload-schemas';
import type { Condition } from '../../strategies/routing';
import type { AuditConfig } from '../load-config';
import type { AuditFinding } from '../types';

/**
 * Condition-path coverage.
 *
 * Routing rules condition on dotted paths into the inbound payload —
 * `equals: { field: issue.fields.status.name, value: Plan }`,
 * `any_item: { path: changelog.items, where: ... }`, etc. Today these
 * paths are unchecked: a typo like `issue.field.status.name` doesn't
 * surface until the first matching webhook fails to match (silent
 * miss) or the runtime accesses a missing property (matching always
 * returns false). Either way the failure mode is "the rule never
 * fires" with no diagnostic.
 *
 * This check walks every rule's condition AST, collects every field
 * path it touches, and validates each against the provider's payload
 * schema. Unknown paths surface as warnings — the editor uses the
 * same schemas as typeahead, so save-time and edit-time both catch
 * the same typos.
 *
 * Severity is `warning` because:
 *   - schemas are intentionally permissive (additionalProperties: true
 *     on most nested objects), so genuine false positives are rare
 *     but possible when a tenant uses a field we haven't modeled.
 *   - the existing audit philosophy is to error on structural
 *     impossibilities (duplicate ids, missing templates, unknown
 *     tools) and warn on contract gaps. A condition typo is a
 *     contract gap.
 */
export function checkConditionPaths(config: AuditConfig): AuditFinding[] {
  const findings: AuditFinding[] = [];

  for (const [providerName, routing] of Object.entries(config.routing)) {
    const providerSchema = getProviderPayloadSchema(providerName);
    if (providerSchema === undefined) continue;

    for (let i = 0; i < routing.rules.length; i += 1) {
      const rule = routing.rules[i] as AuditConfig['routing'][string]['rules'][number];
      if (rule.condition === undefined) continue;
      const ruleId = resolveRuleId(rule, i);
      const unknownPaths = collectUnknownPaths(rule.condition, providerSchema);
      for (const path of unknownPaths) {
        findings.push({
          severity: 'warning',
          rule: 'condition-path-unknown',
          message: `routing.${providerName}.${ruleId} conditions on \`${path}\` but that path isn't defined in the ${providerName} payload schema.`,
          path: 'clawndom.yaml',
          hint: `Either fix the typo, or extend src/strategies/payload-schemas/${getSchemaFileForProvider(providerName)} to model the field. The editor's condition builder uses the same schema for typeahead — adding the field here helps both consumers.`,
        });
      }
    }
  }

  return findings;
}

function collectUnknownPaths(condition: Condition, schema: JsonSchema): readonly string[] {
  const unknown: string[] = [];
  processCondition(condition, schema, unknown);
  return unknown;
}

function processCondition(condition: Condition, schema: JsonSchema, unknown: string[]): void {
  if ('equals' in condition) {
    checkField(condition.equals.field, schema, unknown);
    return;
  }
  if ('in' in condition) {
    checkField(condition.in.field, schema, unknown);
    return;
  }
  if ('matches' in condition) {
    checkField(condition.matches.field, schema, unknown);
    return;
  }
  if ('exists' in condition) {
    checkField(condition.exists.field, schema, unknown);
    return;
  }
  if ('any_item' in condition) {
    const arrayLookup = resolveArrayItem(schema, condition.any_item.path);
    if (!arrayLookup.exists) {
      unknown.push(condition.any_item.path);
      return;
    }
    if (arrayLookup.schema !== undefined) {
      processCondition(condition.any_item.where, arrayLookup.schema, unknown);
    }
    return;
  }
  if ('all_of' in condition) {
    for (const child of condition.all_of) processCondition(child, schema, unknown);
    return;
  }
  if ('any_of' in condition) {
    for (const child of condition.any_of) processCondition(child, schema, unknown);
    return;
  }
  if ('not' in condition) {
    processCondition(condition.not, schema, unknown);
  }
}

function checkField(field: string, schema: JsonSchema, unknown: string[]): void {
  const result = resolvePath(schema, field);
  if (!result.exists) unknown.push(field);
}

function getSchemaFileForProvider(providerName: string): string {
  if (providerName.startsWith('slack')) return 'slack.ts';
  if (providerName.startsWith('gmail')) return 'gmail-pubsub.ts';
  return `${providerName}.ts`;
}
