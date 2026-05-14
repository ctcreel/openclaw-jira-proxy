import type IORedis from 'ioredis';

import { getDedupRedis } from '../../services/dedup.service';

const CALLBACK_DEDUPE_TTL_SECONDS = 24 * 60 * 60;
const KEY_PREFIX = 'builder:callback:event:';

/**
 * Idempotency dedupe for Builder callbacks. Each callback carries
 * `event_id = <job_id>:<state_name>` and the route returns 202 without
 * triggering side effects on the second-and-later delivery of the same
 * event_id. Redis SETEX with a 24h TTL bounds memory; runs longer than
 * 24h are out of scope.
 *
 * Returns `true` if this is the first time the event_id has been
 * recorded (caller should perform the side effect), `false` if it was
 * already recorded (caller should return 202 silently).
 */
export async function saveCallbackEvent(
  eventId: string,
  redis: IORedis = getDedupRedis(),
): Promise<boolean> {
  const result = await redis.set(
    `${KEY_PREFIX}${eventId}`,
    '1',
    'EX',
    CALLBACK_DEDUPE_TTL_SECONDS,
    'NX',
  );
  return result === 'OK';
}

/**
 * Test-only helper: clear a recorded event_id. Production callers should
 * rely on the natural TTL.
 */
export async function clearCallbackEvent(
  eventId: string,
  redis: IORedis = getDedupRedis(),
): Promise<void> {
  await redis.del(`${KEY_PREFIX}${eventId}`);
}
