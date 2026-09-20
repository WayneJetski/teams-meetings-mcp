import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildExportFilename } from '../src/utils/exportFilename.js';

test('a single-session meeting gets no session suffix', () => {
  const name = buildExportFilename({
    title: 'Daily Field Pulse',
    scheduledStartTime: '2026-09-15T13:00:00.000Z',
    timeZone: 'UTC',
  });

  assert.equal(name, '2026-09-15 1300 Daily Field Pulse.json');
});

test('one of several sessions of the same booking is numbered', () => {
  const name = buildExportFilename({
    title: 'Daily Field Pulse',
    scheduledStartTime: '2026-09-15T13:00:00.000Z',
    sessionIndex: 2,
    sessionTotal: 2,
    timeZone: 'UTC',
  });

  assert.equal(name, '2026-09-15 1300 Daily Field Pulse [Session 2].json');
});

test('falls back to the actual start time when there is no booking', () => {
  const name = buildExportFilename({
    title: 'Hand-written note',
    startTime: '2026-01-01T00:00:00.000Z',
    timeZone: 'UTC',
  });

  assert.equal(name, '2026-01-01 0000 Hand-written note.json');
});

test('an untitled or dateless meeting still produces a usable filename', () => {
  assert.equal(buildExportFilename({ timeZone: 'UTC' }), 'Unknown date Untitled Meeting.json');
});

test('filesystem-hostile characters in the title are replaced, not dropped silently', () => {
  const name = buildExportFilename({
    title: 'Q3/Q4: Roadmap? "Final" <draft>',
    scheduledStartTime: '2026-09-15T13:00:00.000Z',
    timeZone: 'UTC',
  });

  assert.equal(name, '2026-09-15 1300 Q3-Q4- Roadmap- -Final- -draft-.json');
});

// ── timezone handling ────────────────────────────────────────────────

test('an explicit timezone is honored, including DST offset', () => {
  const inLA = buildExportFilename({
    title: 'Daily Field Pulse',
    scheduledStartTime: '2026-09-15T13:00:00.000Z',
    timeZone: 'America/Los_Angeles',
  });

  assert.equal(inLA, '2026-09-15 0600 Daily Field Pulse.json');
});

test('no timezone supplied falls back to America/Toronto', () => {
  const name = buildExportFilename({
    title: 'Daily Field Pulse',
    scheduledStartTime: '2026-09-15T13:00:00.000Z',
  });

  assert.equal(name, '2026-09-15 0900 Daily Field Pulse.json', 'EDT is UTC-4 in September');
});

test('a bogus timezone (e.g. a malformed query param) falls back rather than throwing', () => {
  const name = buildExportFilename({
    title: 'Daily Field Pulse',
    scheduledStartTime: '2026-09-15T13:00:00.000Z',
    timeZone: 'not/a-real-zone',
  });

  assert.equal(name, '2026-09-15 0900 Daily Field Pulse.json');
});

test('a fallback across the date line still lands on the correct calendar day', () => {
  const name = buildExportFilename({
    title: "New Year's planning",
    startTime: '2026-01-01T00:00:00.000Z',
    timeZone: 'America/Toronto',
  });

  assert.equal(name, "2025-12-31 1900 New Year's planning.json", 'EST is UTC-5, so UTC midnight is still the previous evening');
});
