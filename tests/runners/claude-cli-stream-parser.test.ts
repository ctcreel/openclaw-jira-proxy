import { describe, it, expect } from 'vitest';

import {
  extractSessionIdFromInitEvent,
  parseQuotaLimitMessage,
} from '../../src/runners/claude-cli-stream-parser';

describe('extractSessionIdFromInitEvent', () => {
  it('returns the session_id from a system.init event', () => {
    const event = {
      type: 'system',
      subtype: 'init',
      session_id: 'sess-abc-123',
    };
    expect(extractSessionIdFromInitEvent(event)).toBe('sess-abc-123');
  });

  it('returns null for system events of other subtypes', () => {
    expect(
      extractSessionIdFromInitEvent({
        type: 'system',
        subtype: 'compact',
        session_id: 'sess-abc-123',
      }),
    ).toBeNull();
  });

  it('returns null for non-system event types', () => {
    expect(
      extractSessionIdFromInitEvent({
        type: 'assistant',
        session_id: 'sess-abc-123',
      }),
    ).toBeNull();
  });

  it('returns null when session_id is missing on a system.init event', () => {
    expect(extractSessionIdFromInitEvent({ type: 'system', subtype: 'init' })).toBeNull();
  });
});

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

  it('parses an IANA zone like America/New_York during DST (EDT, -04:00)', () => {
    // 2026-05-06 15:50 UTC = 11:50 EDT. CLI on a TZ=America/New_York host
    // emits "resets 5:10pm (America/New_York)" — same calendar day, so
    // resetAt should be 21:10 UTC.
    const now = new Date(Date.UTC(2026, 4, 6, 15, 50, 0));
    const result = parseQuotaLimitMessage(
      "You've hit your limit · resets 5:10pm (America/New_York)",
      now,
    );
    expect(result).not.toBeNull();
    expect(new Date(result!.resetAt).toISOString()).toBe('2026-05-06T21:10:00.000Z');
  });

  it('parses an IANA zone like America/New_York during standard time (EST, -05:00)', () => {
    // 2026-01-15 16:00 UTC = 11:00 EST. CLI emits "resets 1:30pm
    // (America/New_York)" — same calendar day, resetAt = 18:30 UTC.
    const now = new Date(Date.UTC(2026, 0, 15, 16, 0, 0));
    const result = parseQuotaLimitMessage(
      "You've hit your limit · resets 1:30pm (America/New_York)",
      now,
    );
    expect(result).not.toBeNull();
    expect(new Date(result!.resetAt).toISOString()).toBe('2026-01-15T18:30:00.000Z');
  });

  it('parses other IANA zones (America/Los_Angeles)', () => {
    // 2026-05-06 18:00 UTC = 11:00 PDT. CLI on a TZ=America/Los_Angeles host
    // emits "resets 4:00pm (America/Los_Angeles)" — resetAt = 23:00 UTC.
    const now = new Date(Date.UTC(2026, 4, 6, 18, 0, 0));
    const result = parseQuotaLimitMessage(
      "You've hit your limit · resets 4:00pm (America/Los_Angeles)",
      now,
    );
    expect(result).not.toBeNull();
    expect(new Date(result!.resetAt).toISOString()).toBe('2026-05-06T23:00:00.000Z');
  });

  it('rolls non-UTC zones over to the next day when reset is at-or-before now', () => {
    // 2026-05-07 04:30 UTC = 2026-05-07 00:30 EDT. CLI emits
    // "resets 1:00am (America/New_York)" — same zoned day, reset = 05:00 UTC,
    // which is AFTER now, so no rollover.
    const noRollover = new Date(Date.UTC(2026, 4, 7, 4, 30, 0));
    const a = parseQuotaLimitMessage(
      "You've hit your limit · resets 1:00am (America/New_York)",
      noRollover,
    );
    expect(a).not.toBeNull();
    expect(new Date(a!.resetAt).toISOString()).toBe('2026-05-07T05:00:00.000Z');

    // 2026-05-07 06:00 UTC = 2026-05-07 02:00 EDT. CLI emits
    // "resets 1:00am (America/New_York)" — same zoned day's 1am is in the
    // past, so reset rolls to next zoned day: 2026-05-08T05:00:00 UTC.
    const rollover = new Date(Date.UTC(2026, 4, 7, 6, 0, 0));
    const b = parseQuotaLimitMessage(
      "You've hit your limit · resets 1:00am (America/New_York)",
      rollover,
    );
    expect(b).not.toBeNull();
    expect(new Date(b!.resetAt).toISOString()).toBe('2026-05-08T05:00:00.000Z');
  });

  it('returns null for an unrecognized timezone string', () => {
    // Limit message detected, but Intl.DateTimeFormat rejects the zone — the
    // runner should treat this as "no resetAt" and let the worker fall back
    // to its pause-and-hold floor rather than computing a wrong instant.
    const now = new Date(Date.UTC(2026, 4, 6, 15, 50, 0));
    expect(
      parseQuotaLimitMessage("You've hit your limit · resets 5:10pm (Not/A_Real_Zone)", now),
    ).toBeNull();
  });
});
