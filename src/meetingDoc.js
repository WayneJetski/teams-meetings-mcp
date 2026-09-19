import { durationMinutes, now } from './utils/timestamps.js';
import { buildSessionId } from './sync/sessionId.js';

/**
 * The canonical meeting-session document.
 *
 * Every writer — the sync engine, the session-id migration, and manual ingest —
 * builds documents here, so no path can invent a partial record that later
 * readers have to special-case.
 */

export const TIME_SOURCE_TRANSCRIPT = 'transcript';
export const TIME_SOURCE_SCHEDULED = 'scheduled_fallback';
export const TIME_SOURCE_MANUAL = 'manual';

/**
 * Resolve a session's time fields from its transcript, falling back to the
 * calendar occurrence when no transcript is available.
 *
 * `start_time`/`end_time`/`duration_minutes` report the actual call so that a
 * 7-minute session inside a 30-minute booking is searchable and summarisable as
 * what it was; the booking is preserved separately. `time_source` records which
 * of the two the primary fields came from, since Graph drops transcripts after
 * its retention window and those documents can only ever carry the booking.
 */
export function sessionTimes({ transcript, scheduledStart, scheduledEnd }) {
  const actualStart = transcript?.createdDateTime ? new Date(transcript.createdDateTime).toISOString() : null;
  const actualEnd = transcript?.endDateTime ? new Date(transcript.endDateTime).toISOString() : null;

  const start = actualStart || scheduledStart || null;
  const end = actualEnd || scheduledEnd || null;

  return {
    start_time: start,
    end_time: end,
    duration_minutes: start && end ? durationMinutes(start, end) : 0,
    scheduled_start_time: scheduledStart || null,
    scheduled_end_time: scheduledEnd || null,
    time_source: actualStart ? TIME_SOURCE_TRANSCRIPT : TIME_SOURCE_SCHEDULED,
    transcript_id: transcript?.id || null,
    call_id: transcript?.callId || null,
  };
}

/**
 * Times for a document pushed in through the ingest API. There is no booking
 * distinct from the call, so the supplied times serve as both and are marked
 * `manual` rather than claiming to have come from a transcript.
 */
export function manualTimes({ start = null, end = null, duration = null }) {
  return {
    start_time: start,
    end_time: end,
    duration_minutes: duration ?? (start && end ? durationMinutes(start, end) : 0),
    scheduled_start_time: start,
    scheduled_end_time: end,
    time_source: TIME_SOURCE_MANUAL,
    transcript_id: null,
    call_id: null,
  };
}

/**
 * Assemble a complete document. `meetingId` is derived from the session start
 * when the caller has no id of its own.
 */
export function buildMeetingDoc({
  meetingId = null,
  onlineMeetingId = null,
  calendarEventId = null,
  title,
  organizer = '',
  attendees = [],
  times,
  summary = null,
  meetingNotes = [],
  actionItems = [],
  decisions = [],
  topics = [],
  transcriptText = null,
  dataSource,
  syncedAt = null,
  rawGraphResponse = {},
  graphAccessible = true,
}) {
  return {
    meeting_id: meetingId || buildSessionId(onlineMeetingId, times.start_time),
    calendar_event_id: calendarEventId,
    online_meeting_id: onlineMeetingId,
    title: title || 'Untitled Meeting',
    organizer: typeof organizer === 'string' ? organizer.toLowerCase() : '',
    attendees,
    ...times,
    summary,
    meeting_notes: meetingNotes,
    action_items: actionItems,
    decisions,
    topics,
    transcript_text: transcriptText,
    data_source: dataSource,
    synced_at: syncedAt || now(),
    raw_graph_response: rawGraphResponse,
    // False only for a document imported from someone else's export — Graph
    // never granted this install access to it directly (that's the whole
    // reason it had to be imported), so a future rebuild-from-Graph workload
    // must not expect to be able to re-fetch or re-verify it.
    graph_accessible: graphAccessible,
  };
}
