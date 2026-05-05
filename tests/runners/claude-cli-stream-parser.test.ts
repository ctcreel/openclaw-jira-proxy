import { describe, it, expect } from 'vitest';

import { parseQuotaLimitMessage } from '../../src/runners/claude-cli-stream-parser';

describe('parseQuotaLimitMessage', () => {
  it('parses the production limit-hit message with pm meridiem', () => {
    // Reference now: 2026-05-05T17:30:00 UTC. Reset at 6:40pm UTC = same-day later.
    const now = new Date(Date.UTC(2026, 4, 5, 17, 30, 0));
    const result = parseQuotaLimitMessage("You've hit your limit · resets 6:40pm (UTC)", now);
    expect(result).not.toBeNull();
    expect(new Date(result!.resetAt).toISOString()).toBe('2026-05-05T18:40:00.000Z');
  });

  it('parses am-meridiem and rolls over to the next day when reset is before now', () => {
    // Limit hit at 11:30pm UTC; reset at 1:00am UTC means tomorrow.
    const now = new Date(Date.UTC(2026, 4, 5, 23, 30, 0));
    const result = parseQuotaLimitMessage("You've hit your limit · resets 1:00am (UTC)", now);
    expect(result).not.toBeNull();
    expect(new Date(result!.resetAt).toISOString()).toBe('2026-05-06T01:00:00.000Z');
  });

  it('parses the bare-hour form (no minutes)', () => {
    const now = new Date(Date.UTC(2026, 4, 5, 10, 0, 0));
    const result = parseQuotaLimitMessage("You've hit your limit · resets 2pm (UTC)", now);
    expect(result).not.toBeNull();
    expect(new Date(result!.resetAt).toISOString()).toBe('2026-05-05T14:00:00.000Z');
  });

  it('handles 12am (midnight) and 12pm (noon) correctly', () => {
    const now = new Date(Date.UTC(2026, 4, 5, 11, 0, 0));
    const noon = parseQuotaLimitMessage("You've hit your limit · resets 12:00pm (UTC)", now);
    expect(new Date(noon!.resetAt).toISOString()).toBe('2026-05-05T12:00:00.000Z');

    const lateNight = new Date(Date.UTC(2026, 4, 5, 22, 0, 0));
    const midnight = parseQuotaLimitMessage(
      "You've hit your limit · resets 12:00am (UTC)",
      lateNight,
    );
    // 12am rolls over to next day since it's at or before "now".
    expect(new Date(midnight!.resetAt).toISOString()).toBe('2026-05-06T00:00:00.000Z');
  });

  it('tolerates an em-dash separator instead of the middot', () => {
    const now = new Date(Date.UTC(2026, 4, 5, 10, 0, 0));
    const result = parseQuotaLimitMessage("You've hit your limit — resets 6:40pm (UTC)", now);
    expect(result).not.toBeNull();
  });

  it('returns null for unrelated assistant text', () => {
    const now = new Date();
    expect(parseQuotaLimitMessage("I'll take a look at this issue.", now)).toBeNull();
    expect(parseQuotaLimitMessage('Reading the file.', now)).toBeNull();
    expect(
      parseQuotaLimitMessage(
        'The user said "you have hit your limit" but in another context.',
        now,
      ),
    ).toBeNull();
  });

  it('returns null when the limit message is embedded in surrounding text', () => {
    // Anchor regression: if the agent ever quotes the limit phrase in a
    // longer message, we must NOT misclassify the run as quota_exceeded.
    // Production claude-cli emits this as a standalone block, so anchoring
    // is safe.
    const now = new Date(Date.UTC(2026, 4, 5, 17, 30, 0));
    expect(
      parseQuotaLimitMessage(
        "As we discussed earlier, you've hit your limit · resets 6:40pm (UTC), so I'll stop here.",
        now,
      ),
    ).toBeNull();
  });

  it('returns null when the time format is malformed', () => {
    const now = new Date();
    expect(parseQuotaLimitMessage("You've hit your limit · resets soon", now)).toBeNull();
    expect(parseQuotaLimitMessage("You've hit your limit · resets 25:00pm (UTC)", now)).toBeNull();
  });
});
