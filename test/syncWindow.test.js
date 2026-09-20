import { test } from 'node:test';
import assert from 'node:assert/strict';

// Dependency-free: syncWindow imports nothing, so this runs under `npm test`
// without installing node_modules (matching the repo's test style).
import { resolveLookbackDays, computeWatermark, withinRetryWindow, classifyUncaptured } from '../src/sync/syncWindow.js';

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

// ── withinRetryWindow ────────────────────────────────────────────────

test('an occurrence younger than the give-up threshold is still retried', () => {
  assert.equal(withinRetryWindow({ eventStart: daysBefore(2), nowMs: NOW, giveUpDays: 3 }), true);
});

test('an occurrence older than the give-up threshold is not', () => {
  assert.equal(withinRetryWindow({ eventStart: daysBefore(4), nowMs: NOW, giveUpDays: 3 }), false);
});

test('a missing or unparseable event start errs toward retrying', () => {
  assert.equal(withinRetryWindow({ eventStart: null, nowMs: NOW, giveUpDays: 3 }), true);
  assert.equal(withinRetryWindow({ eventStart: 'not-a-date', nowMs: NOW, giveUpDays: 3 }), true);
});

// ── classifyUncaptured ───────────────────────────────────────────────

test('an isolated dead occurrence is given up on once past the threshold', () => {
  const { oldestUncapturedStart, abandoned, isOutage, failures } = classifyUncaptured({
    uncaptured: [{ eventStart: daysBefore(30), title: 'Daily Repeats', reason: 'No transcript available' }],
    totalEvents: 115, // everything else in the run succeeded
    nowMs: NOW,
    giveUpDays: 3,
  });

  assert.equal(isOutage, false);
  assert.equal(abandoned, 1);
  assert.equal(oldestUncapturedStart, null, 'nothing left to hold the watermark back');
  assert.equal(failures[0].retrying, false);
  assert.equal(failures[0].title, 'Daily Repeats');
});

test('a recent isolated failure still holds the watermark', () => {
  const recent = daysBefore(1);
  const { oldestUncapturedStart, abandoned, isOutage, failures } = classifyUncaptured({
    uncaptured: [{ eventStart: recent, title: 'Review S3 Bucket Lifecycles', reason: 'No transcript available' }],
    totalEvents: 115,
    nowMs: NOW,
    giveUpDays: 3,
  });

  assert.equal(isOutage, false);
  assert.equal(abandoned, 0);
  assert.equal(oldestUncapturedStart, recent);
  assert.equal(failures[0].retrying, true);
});

test('every occurrence failing is treated as an outage regardless of age', () => {
  // Reproduces the Jul 30 - Aug 9 incident: every occurrence failed for 11
  // days straight. A flat give-up threshold would have written off the early
  // days of the outage before it was fixed; the outage check must override it.
  const ancient = daysBefore(30);
  const { oldestUncapturedStart, abandoned, isOutage, failures } = classifyUncaptured({
    uncaptured: [
      { eventStart: ancient, title: 'Old Meeting', reason: 'No transcript available' },
      { eventStart: daysBefore(1), title: 'Recent Meeting', reason: 'No transcript available' },
    ],
    totalEvents: 2, // every discovered occurrence failed
    nowMs: NOW,
    giveUpDays: 3,
  });

  assert.equal(isOutage, true);
  assert.equal(abandoned, 0, 'an outage abandons nothing, however old');
  assert.equal(oldestUncapturedStart, ancient);
  assert.ok(failures.every((f) => f.retrying), 'an outage retries everything regardless of age');
});

test('a clean run with nothing uncaptured is not mistaken for an outage', () => {
  const { isOutage, abandoned, oldestUncapturedStart } = classifyUncaptured({
    uncaptured: [],
    totalEvents: 115,
    nowMs: NOW,
    giveUpDays: 3,
  });

  assert.equal(isOutage, false);
  assert.equal(abandoned, 0);
  assert.equal(oldestUncapturedStart, null);
});
