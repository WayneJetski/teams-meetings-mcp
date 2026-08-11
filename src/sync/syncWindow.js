/**
 * Pure date-window arithmetic for the sync engine.
 *
 * Kept free of imports so it can be unit tested without node_modules,
 * matching the repo's dependency-free test style.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Decide how many days back a sync run should look.
 *
 * An explicit lookback (a forced/manual sync) always wins and uses the full
 * window. Otherwise the run is incremental: it reaches back to the last
 * watermark plus a one-day overlap buffer, capped at the configured maximum.
 */
export function resolveLookbackDays({
  explicitLookbackDays,
  configuredLookbackDays,
  lastSuccessfulSync,
  nowMs,
}) {
  if (explicitLookbackDays) return explicitLookbackDays;
  if (!lastSuccessfulSync) return configuredLookbackDays;

  const lastSyncMs = new Date(lastSuccessfulSync).getTime();
  if (Number.isNaN(lastSyncMs)) return configuredLookbackDays;

  const daysSinceLastSync = (nowMs - lastSyncMs) / MS_PER_DAY;
  const incrementalDays = Math.ceil(daysSinceLastSync) + 1; // +1 day overlap buffer

  // Clamp to >= 1 so a watermark in the future (clock skew, a restored
  // snapshot) can't collapse the window to zero and silently sync nothing.
  return Math.min(Math.max(incrementalDays, 1), configuredLookbackDays);
}

/**
 * Compute the watermark to persist after a sync run.
 *
 * The watermark must never advance past an occurrence we failed to capture.
 * Each run derives its window from this value, so advancing unconditionally
 * lets a systemic failure (Graph rejecting every transcript fetch, an expired
 * scope, a Teams-side outage) slide the affected days permanently out of
 * range: every run moves the window forward, indexes nothing, and the missed
 * days are never revisited. Holding the watermark at the oldest uncaptured
 * occurrence makes the next run retry it, so the gap heals on its own once the
 * underlying problem clears.
 *
 * Floored at the full lookback window: an occurrence that will never have a
 * transcript (never recorded, no longer accessible) must not pin the window
 * open indefinitely. The cost of holding is a wider scan per run, bounded by
 * `maxLookbackDays`; that is a deliberate trade of a few extra Graph calls for
 * not losing meetings.
 */
export function computeWatermark({ oldestUncapturedStart, nowMs, maxLookbackDays }) {
  if (!oldestUncapturedStart) return new Date(nowMs).toISOString();

  const uncapturedMs = new Date(oldestUncapturedStart).getTime();
  if (Number.isNaN(uncapturedMs)) return new Date(nowMs).toISOString();

  const floorMs = nowMs - maxLookbackDays * MS_PER_DAY;
  return new Date(Math.min(nowMs, Math.max(uncapturedMs, floorMs))).toISOString();
}
