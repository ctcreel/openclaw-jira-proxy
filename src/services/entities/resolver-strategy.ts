export interface IdentityHints {
  email?: string;
  slack_user_id?: string;
  oidc_email?: string;
  phone?: string;
}

export interface InboundEvent {
  identityHints?: IdentityHints;
}

export interface ResolverStrategy {
  readonly hintName: keyof IdentityHints;
  readonly propertyFormat: string | null;
  readonly propertyName: string | null;
  readonly priority: number;
  extractHint(event: InboundEvent): string | null;
  normalize(raw: string): string;
}

export interface StrategyMatchTarget {
  kind: string;
  property: string;
}

export interface ResolverStrategyIndex {
  byFormat: Record<string, StrategyMatchTarget[]>;
  byPropertyName: Record<string, StrategyMatchTarget[]>;
}

export function getTargetsFor(
  strategy: ResolverStrategy,
  index: ResolverStrategyIndex,
): StrategyMatchTarget[] {
  if (strategy.propertyFormat !== null) {
    return index.byFormat[strategy.propertyFormat] ?? [];
  }
  if (strategy.propertyName !== null) {
    return index.byPropertyName[strategy.propertyName] ?? [];
  }
  return [];
}
