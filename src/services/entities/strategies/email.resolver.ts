import type { InboundEvent, ResolverStrategy } from '../resolver-strategy';

export class EmailResolverStrategy implements ResolverStrategy {
  readonly hintName = 'email' as const;
  readonly propertyFormat = 'email';
  readonly propertyName = null;
  readonly priority = 20;

  extractHint(event: InboundEvent): string | null {
    return event.identityHints?.email ?? event.identityHints?.oidc_email ?? null;
  }

  normalize(raw: string): string {
    return raw.trim().toLowerCase();
  }
}
