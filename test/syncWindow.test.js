import { test } from 'node:test';
import assert from 'node:assert/strict';

// Dependency-free: syncWindow imports nothing, so this runs under `npm test`
// without installing node_modules (matching the repo's test style).
import { resolveLookbackDays, computeWatermark } from '../src/sync/syncWindow.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-08-11T12:00:00.000Z');
const daysBefore = (n) => new Date(NOW - n * MS_PER_DAY).toISOString();

// ── resolveLookbackDays ──────────────────────────────────────────────

test('a forced sync uses its explicit window and ignores the watermark', () => {
  const days = resolveLookbackDays({
    explicitLookbackDays: 30,
    configuredLookbackDays: 30,
    lastSuccessfulSync: daysBefore(0.01),
    nowMs: NOW,
  });
  assert.equal(days, 30);
});

test('with no watermark yet, the full configured window is used', () => {
  const days = resolveLookbackDays({
    explicitLookbackDays: undefined,
    configuredLookbackDays: 30,
    lastSuccessfulSync: null,
    nowMs: NOW,
  });
  assert.equal(days, 30);
});

test('a recent watermark narrows the window to a 2-day overlap', () => {
  const days = resolveLookbackDays({
    explicitLookbackDays: undefined,
    configuredLookbackDays: 30,
    lastSuccessfulSync: daysBefore(0.01), // last run ~15 minutes ago
    nowMs: NOW,
  });
  assert.equal(days, 2);
});

test('a stale watermark reaches back to it, capped at the configured maximum', () => {
  assert.equal(
    resolveLookbackDays({
      explicitLookbackDays: undefined,
      configuredLookbackDays: 30,
      lastSuccessfulSync: daysBefore(12),
      nowMs: NOW,
    }),
    13
  );

  assert.equal(
    resolveLookbackDays({
      explicitLookbackDays: undefined,
      configuredLookbackDays: 30,
      lastSuccessfulSync: daysBefore(90),
      nowMs: NOW,
    }),
    30
  );
});

test('a watermark in the future cannot collapse the window to zero', () => {
  const days = resolveLookbackDays({
    explicitLookbackDays: undefined,
    configuredLookbackDays: 30,
    lastSuccessfulSync: new Date(NOW + 5 * MS_PER_DAY).toISOString(),
    nowMs: NOW,
  });
  assert.equal(days, 1);
});

// ── computeWatermark ─────────────────────────────────────────────────

test('a clean run advances the watermark to now', () => {
  const watermark = computeWatermark({
    oldestUncapturedStart: null,
    nowMs: NOW,
    maxLookbackDays: 30,
  });
  assert.equal(watermark, new Date(NOW).toISOString());
});

test('the watermark is held at the oldest uncaptured occurrence', () => {
  const missed = daysBefore(3);
  const watermark = computeWatermark({
    oldestUncapturedStart: missed,
    nowMs: NOW,
    maxLookbackDays: 30,
  });
  assert.equal(watermark, missed);
});

test('a permanently uncapturable occurrence cannot pin the window past the max lookback', () => {
  const watermark = computeWatermark({
    oldestUncapturedStart: daysBefore(400),
    nowMs: NOW,
    maxLookbackDays: 30,
  });
  assert.equal(watermark, daysBefore(30));
});

test('an unparseable occurrence start does not corrupt the watermark', () => {
  const watermark = computeWatermark({
    oldestUncapturedStart: 'not-a-date',
    nowMs: NOW,
    maxLookbackDays: 30,
  });
  assert.equal(watermark, new Date(NOW).toISOString());
});

// ── regression: the Jul 30 - Aug 9 silent gap ────────────────────────

test('regression: a systemic transcript failure no longer walks the window past the gap', () => {
  // Reproduces the incident: the tenant disabled speaker-attributed
  // transcripts, so every fetch returned nothing. Each run indexed zero
  // meetings but still advanced the watermark, sliding the failed days out of
  // the 2-day incremental window for good.
  const outageStart = Date.parse('2026-07-30T13:00:00.000Z');
  let watermark = new Date(Date.parse('2026-07-30T00:45:00.000Z')).toISOString();

  // Simulate 11 days of 15-minute runs that capture nothing.
  for (let tick = 1; tick <= 11 * 96; tick++) {
    const runAt = outageStart + tick * 15 * 60 * 1000;

    const lookback = resolveLookbackDays({
      explicitLookbackDays: undefined,
      configuredLookbackDays: 30,
      lastSuccessfulSync: watermark,
      nowMs: runAt,
    });

    // Every occurrence since the outage began stays uncaptured.
    const windowStart = runAt - lookback * MS_PER_DAY;
    assert.ok(
      windowStart <= outageStart,
      `run at ${new Date(runAt).toISOString()} no longer reaches the first missed occurrence`
    );

    watermark = computeWatermark({
      oldestUncapturedStart: new Date(outageStart).toISOString(),
      nowMs: runAt,
      maxLookbackDays: 30,
    });
  }

  // After the fallback ships, the first run still covers the whole outage.
  assert.equal(watermark, new Date(outageStart).toISOString());
});
