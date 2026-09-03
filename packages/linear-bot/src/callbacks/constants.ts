/** Signed control-plane callbacks older than this are ignored (replay/staleness guard). */
export const CALLBACK_MAX_AGE_MS = 5 * 60 * 1000;
/** Tolerated clock skew for callbacks stamped slightly in the future. */
export const CALLBACK_MAX_FUTURE_SKEW_MS = 60 * 1000;

/** True when a callback timestamp is outside the accepted freshness window. */
export function isStaleCallback(timestamp: number, now: number): boolean {
  const ageMs = now - timestamp;
  return ageMs > CALLBACK_MAX_AGE_MS || ageMs < -CALLBACK_MAX_FUTURE_SKEW_MS;
}
