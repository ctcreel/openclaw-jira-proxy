export { registerRoutingStrategy, getRoutingStrategy, resetRoutingStrategies } from './registry';
export { fieldEqualsStrategy } from './field-equals';
export { regexStrategy } from './regex';
export { defaultStrategy } from './default';
export { resolveAgent } from './resolve';
export { resolveFieldPath } from './field-path';
export type { RoutingStrategy, RoutingRule, RoutingConfig } from './types';
export { routingRuleSchema, routingConfigSchema } from './types';
