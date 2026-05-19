import type { InboundEvent, ResolverStrategy } from '../resolver-strategy';

export class SlackUserIdResolverStrategy implements ResolverStrategy {
  readonly hintName = 'slack_user_id' as const;
  readonly propertyFormat = null;
  readonly propertyName = 'slack_user_id';
  readonly priority = 10;

  extractHint(event: InboundEvent): string | null {
    return event.identityHints?.slack_user_id ?? null;
  }

  normalize(raw: string): string {
    return raw.trim();
  }
}
