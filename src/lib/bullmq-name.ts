/**
 * BullMQ queue-name validator.
 *
 * Real BullMQ rejects queue names containing ':' because that character is
 * its Redis key separator — a Queue/Worker/QueueEvents constructor with such
 * a name throws at runtime. Two production crashes (SPE-1824, SPE-1999) hit
 * this exact bug; both shipped through CI green because per-test BullMQ mocks
 * skipped the rejection that real BullMQ enforces.
 *
 * This helper is the single precondition assertion for every queue name the
 * application constructs. Wire every producer through it (see
 * `queue.service.ts`, `task.service.ts`, `orphan-reaper.service.ts`); the
 * shared test mock (`tests/helpers/bullmq-mock.ts`) calls it inside each
 * constructor so the unit-test layer enforces the same rule as runtime.
 *
 * NOTE: scheduler IDs (the first arg of `Queue.upsertJobScheduler`) are NOT
 * subject to BullMQ's ':'-rejection rule and DO NOT route through this
 * helper — Scarlett's production scheduler ID `schedule:scarlett:daily-handoff`
 * is operational. This helper applies only to queue names.
 */

// Stricter than BullMQ's actual runtime rule (which only rejects ':') —
// intentionally enforces identifier hygiene: no uppercase, no spaces, no
// leading non-alphanumeric. Prevents the next "BullMQ allows this — why
// don't we?" debate by codifying the project's narrower convention.
export const BULLMQ_SAFE_NAME = /^[a-z0-9][a-z0-9_-]*$/;

// `assert*` is the standard Node/TS convention for throw-on-violation
// predicates (cf. `node:assert`). The naming-checker's CORE_VERBS list
// doesn't include `assert`, but the semantic is precisely the right one
// here: callers should read this as "guarantee the name is safe or
// throw," not "fetch / build / validate-and-return-bool."
// noqa: NAMING001
export function assertBullmqSafeName(name: string): void {
  if (name.includes(':')) {
    throw new Error(
      `BullMQ queue name '${name}' contains ':' (BullMQ uses ':' as its Redis key separator).`,
    );
  }
  if (!BULLMQ_SAFE_NAME.test(name)) {
    throw new Error(`BullMQ queue name '${name}' is not safe (must match ${BULLMQ_SAFE_NAME}).`);
  }
}
