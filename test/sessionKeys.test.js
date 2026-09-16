import { test } from 'node:test';
import assert from 'node:assert/strict';

// Dependency-free: these modules import nothing outside src/, so this runs
// under `npm test` without installing node_modules (matching the repo's test
// style).
import { buildSessionId, buildLegacyInstanceId, compactInstant, isLegacyId } from '../src/sync/sessionId.js';
import { transcriptsInWindow } from '../src/sync/transcriptWindow.js';
import {
  sessionTimes,
  manualTimes,
  buildMeetingDoc,
  TIME_SOURCE_TRANSCRIPT,
  TIME_SOURCE_SCHEDULED,
  TIME_SOURCE_MANUAL,
} from '../src/meetingDoc.js';
import {
  classifyDoc,
  REKEY, REBUILD, FALLBACK, SKIP, NOOP,
  GRAPH_OK, GRAPH_NOT_FOUND, GRAPH_FAILED,
} from '../src/sync/migrationPlan.js';
import { decideMigrationOutcome, RECORD, RETRY, GIVE_UP, WAIT } from '../src/sync/migrationOutcome.js';

const OM = 'MSoyY2MwOGIzMC03MTVm';
const SCHEDULED_START = '2026-09-15T13:00:00.000Z';
const SCHEDULED_END = '2026-09-15T13:30:00.000Z';

const transcript = (created, end, id = created) => ({
  id: `transcript-${id}`,
  callId: `call-${id}`,
  createdDateTime: created,
  endDateTime: end,
});

// The two sessions of the 2026-09-15 Daily Field Pulse, the occurrence that
// exposed the collapse.
const SESSION_1 = transcript('2026-09-15T13:00:30.874873Z', '2026-09-15T13:07:08.114873Z', 'a');
const SESSION_2 = transcript('2026-09-15T13:13:51.948881Z', '2026-09-15T13:21:03.968881Z', 'b');

// ── session ids ──────────────────────────────────────────────────────

test('two sessions of one occurrence get distinct ids', () => {
  const first = buildSessionId(OM, SESSION_1.createdDateTime);
  const second = buildSessionId(OM, SESSION_2.createdDateTime);

  assert.equal(first, `${OM}_20260915T130030Z`);
  assert.notEqual(first, second);
});

test('sub-second precision is dropped so an id is stable and readable', () => {
  assert.equal(compactInstant('2026-09-15T13:00:30.874873Z'), '20260915T130030Z');
});

test('legacy occurrence ids are recognised and new session ids are not', () => {
  assert.ok(isLegacyId(buildLegacyInstanceId(OM, SCHEDULED_START)));
  assert.equal(isLegacyId(buildSessionId(OM, SESSION_1.createdDateTime)), false);
});

// ── window matching ──────────────────────────────────────────────────

test('every session inside the window is returned, oldest first', () => {
  const matched = transcriptsInWindow([SESSION_2, SESSION_1], SCHEDULED_START, SCHEDULED_END);

  assert.deepEqual(matched.map((t) => t.id), [SESSION_1.id, SESSION_2.id]);
});

test('input order is never trusted — Graph orders by transcript id, not date', () => {
  const unordered = [SESSION_2, SESSION_1];
  const matched = transcriptsInWindow(unordered, SCHEDULED_START, SCHEDULED_END);

  assert.equal(matched[0].id, SESSION_1.id);
  assert.equal(unordered[0].id, SESSION_2.id, 'the caller’s array must not be reordered in place');
});

test('a session from another occurrence of the same series is excluded', () => {
  const yesterday = transcript('2026-09-14T13:00:20Z', '2026-09-14T13:11:19Z');
  const matched = transcriptsInWindow([yesterday, SESSION_1], SCHEDULED_START, SCHEDULED_END);

  assert.deepEqual(matched.map((t) => t.id), [SESSION_1.id]);
});

test('an early join inside the buffer still matches; an unrelated call does not', () => {
  const early = transcript('2026-09-15T12:05:00Z', '2026-09-15T12:40:00Z');
  const muchLater = transcript('2026-09-15T20:35:53Z', '2026-09-15T20:58:04Z');
  const matched = transcriptsInWindow([early, muchLater, SESSION_1], SCHEDULED_START, SCHEDULED_END);

  assert.deepEqual(matched.map((t) => t.id), [early.id, SESSION_1.id]);
});

// ── session times ────────────────────────────────────────────────────

test('actual call times are primary and the booking is kept alongside', () => {
  const times = sessionTimes({
    transcript: SESSION_1,
    scheduledStart: SCHEDULED_START,
    scheduledEnd: SCHEDULED_END,
  });

  assert.equal(times.start_time, '2026-09-15T13:00:30.874Z');
  assert.equal(times.duration_minutes, 7, 'a 7-minute call must not report its 30-minute booking');
  assert.equal(times.scheduled_start_time, SCHEDULED_START);
  assert.equal(times.scheduled_end_time, SCHEDULED_END);
  assert.equal(times.time_source, TIME_SOURCE_TRANSCRIPT);
  assert.equal(times.call_id, SESSION_1.callId);
  assert.equal(times.transcript_id, SESSION_1.id);
});

test('without a transcript the booking is used and marked as such', () => {
  const times = sessionTimes({
    transcript: null,
    scheduledStart: SCHEDULED_START,
    scheduledEnd: SCHEDULED_END,
  });

  assert.equal(times.start_time, SCHEDULED_START);
  assert.equal(times.duration_minutes, 30);
  assert.equal(times.time_source, TIME_SOURCE_SCHEDULED);
  assert.equal(times.call_id, null);
});

test('manually ingested times are marked manual, not passed off as a transcript', () => {
  const times = manualTimes({ start: SCHEDULED_START, end: SCHEDULED_END });

  assert.equal(times.time_source, TIME_SOURCE_MANUAL);
  assert.equal(times.duration_minutes, 30);
  assert.equal(times.scheduled_start_time, SCHEDULED_START, 'a manual record has no booking distinct from the call');
  assert.equal(times.transcript_id, null);
});

test('an explicit manual duration wins over the one implied by the times', () => {
  const times = manualTimes({ start: SCHEDULED_START, end: SCHEDULED_END, duration: 12 });

  assert.equal(times.duration_minutes, 12);
});

// ── document assembly ────────────────────────────────────────────────

test('every writer produces the same field set', () => {
  const fromSync = buildMeetingDoc({
    onlineMeetingId: OM,
    title: 'Daily Field Pulse',
    times: sessionTimes({ transcript: SESSION_1, scheduledStart: SCHEDULED_START, scheduledEnd: SCHEDULED_END }),
    dataSource: 'transcript',
  });
  const fromIngest = buildMeetingDoc({
    meetingId: 'manual-1',
    title: 'Hand-written note',
    times: manualTimes({ start: SCHEDULED_START, end: SCHEDULED_END }),
    dataSource: 'manual',
  });

  assert.deepEqual(Object.keys(fromSync).sort(), Object.keys(fromIngest).sort());
  assert.equal(fromSync.time_source, TIME_SOURCE_TRANSCRIPT);
  assert.equal(fromIngest.time_source, TIME_SOURCE_MANUAL);
});

test('a document with no id of its own is keyed on its session start', () => {
  const doc = buildMeetingDoc({
    onlineMeetingId: OM,
    title: 'Daily Field Pulse',
    times: sessionTimes({ transcript: SESSION_2, scheduledStart: SCHEDULED_START, scheduledEnd: SCHEDULED_END }),
    dataSource: 'transcript',
  });

  assert.equal(doc.meeting_id, `${OM}_20260915T131351Z`);
});

test('a caller-supplied id is preserved', () => {
  const doc = buildMeetingDoc({
    meetingId: 'manual-1',
    title: 'Hand-written note',
    times: manualTimes({ start: SCHEDULED_START, end: SCHEDULED_END }),
    dataSource: 'manual',
  });

  assert.equal(doc.meeting_id, 'manual-1');
});

test('an untitled document still gets a title, and organizers are normalised', () => {
  const doc = buildMeetingDoc({
    meetingId: 'manual-2',
    organizer: 'Jens.Busse@TrueContext.com',
    times: manualTimes({}),
    dataSource: 'manual',
  });

  assert.equal(doc.title, 'Untitled Meeting');
  assert.equal(doc.organizer, 'jens.busse@truecontext.com');
  assert.equal(doc.duration_minutes, 0);
});

// ── migration planning ───────────────────────────────────────────────

const legacyDoc = (overrides = {}) => ({
  meeting_id: buildLegacyInstanceId(OM, SCHEDULED_START),
  online_meeting_id: OM,
  start_time: SCHEDULED_START,
  end_time: SCHEDULED_END,
  ...overrides,
});

test('a single-session occurrence is re-keyed without re-downloading content', () => {
  const { action, sessions } = classifyDoc(legacyDoc(), [SESSION_1], { graphStatus: GRAPH_OK });

  assert.equal(action, REKEY);
  assert.deepEqual(sessions.map((s) => s.id), [SESSION_1.id]);
});

test('a multi-session occurrence is rebuilt, since the stored text is unattributable', () => {
  const { action, sessions } = classifyDoc(legacyDoc(), [SESSION_1, SESSION_2], { graphStatus: GRAPH_OK });

  assert.equal(action, REBUILD);
  assert.equal(sessions.length, 2);
});

test('a document past Graph retention falls back to its booking rather than being dropped', () => {
  const { action } = classifyDoc(legacyDoc(), [], { graphStatus: GRAPH_NOT_FOUND });

  assert.equal(action, FALLBACK);
});

test('a failed Graph call skips the document instead of degrading it', () => {
  const { action } = classifyDoc(legacyDoc(), [], { graphStatus: GRAPH_FAILED });

  assert.equal(action, SKIP, 'auth/throttling/network must never be mistaken for expiry');
});

test('an occurrence Graph knows but has no transcript for falls back', () => {
  const otherDay = transcript('2026-09-14T13:00:20Z', '2026-09-14T13:11:19Z');
  const { action } = classifyDoc(legacyDoc(), [otherDay], { graphStatus: GRAPH_OK });

  assert.equal(action, FALLBACK);
});

test('an already-migrated document is left alone', () => {
  const migrated = legacyDoc({ meeting_id: buildSessionId(OM, SESSION_1.createdDateTime) });

  assert.equal(classifyDoc(migrated, [SESSION_1], { graphStatus: GRAPH_OK }).action, NOOP);
});

test('re-running the migration over its own output is a no-op', () => {
  const migrated = legacyDoc({ meeting_id: buildSessionId(OM, SESSION_2.createdDateTime) });

  assert.equal(classifyDoc(migrated, [SESSION_1, SESSION_2], { graphStatus: GRAPH_OK }).action, NOOP);
});

test('an already-migrated document is untouched even when Graph is unreachable', () => {
  const migrated = legacyDoc({ meeting_id: buildSessionId(OM, SESSION_1.createdDateTime) });

  assert.equal(classifyDoc(migrated, [], { graphStatus: GRAPH_FAILED }).action, NOOP);
});

// ── migration retry budget ───────────────────────────────────────────

test('a clean run records the schema version', () => {
  const outcome = decideMigrationOutcome({ complete: true, attempts: 0, maxAttempts: 5 });

  assert.equal(outcome, RECORD);
});

test('not being signed in waits forever without spending the budget', () => {
  const outcome = decideMigrationOutcome({
    complete: false,
    reason: 'not_authenticated',
    attempts: 4,
    maxAttempts: 5,
  });

  assert.equal(outcome, WAIT, 'an unauthenticated install must still migrate once someone signs in');
});

test('unresolved documents retry while budget remains', () => {
  const outcome = decideMigrationOutcome({ complete: false, attempts: 1, maxAttempts: 5 });

  assert.equal(outcome, RETRY);
});

test('an exhausted budget records the version so startup stops rescanning', () => {
  const outcome = decideMigrationOutcome({ complete: false, attempts: 4, maxAttempts: 5 });

  assert.equal(outcome, GIVE_UP);
});
