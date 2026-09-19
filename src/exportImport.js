import { getMeetingForExport, findSessionPosition, indexMeeting } from './elasticsearch.js';
import { buildMeetingDoc } from './meetingDoc.js';
import { buildExportFilename } from './utils/exportFilename.js';
import { now } from './utils/timestamps.js';

export const EXPORT_FORMAT = 'teams-meeting-insights/meeting-export';
export const EXPORT_VERSION = 1;

/**
 * Bundle one or more meetings into a portable envelope another install's
 * `importMeetings` can consume. Only export-safe fields — Graph's raw
 * response is install-specific and dropped by `getMeetingForExport`.
 */
export async function exportMeetings(meetingIds, { exportedBy = null, timeZone } = {}) {
  const meetings = [];
  const errors = [];

  for (const meetingId of meetingIds) {
    const doc = await getMeetingForExport(meetingId);
    if (!doc) {
      errors.push({ meeting_id: meetingId, error: 'not found' });
      continue;
    }

    const { index, total } = await findSessionPosition(doc.online_meeting_id, doc.scheduled_start_time, meetingId);
    doc.export_filename = buildExportFilename({
      title: doc.title,
      scheduledStartTime: doc.scheduled_start_time,
      startTime: doc.start_time,
      sessionIndex: index,
      sessionTotal: total,
      timeZone,
    });
    meetings.push(doc);
  }

  return {
    export_format: EXPORT_FORMAT,
    export_version: EXPORT_VERSION,
    exported_at: now(),
    exported_by: exportedBy,
    meetings,
    ...(errors.length ? { errors } : {}),
  };
}

/**
 * Index every meeting in an export envelope, unconditionally marked
 * `graph_accessible: false` — the whole reason a meeting travels through
 * export/import is that this install can't reach it via Graph itself.
 *
 * Original time fields and `time_source` are carried through as-is rather
 * than reconstructed, so a transcript-timed session doesn't get flattened
 * into a manual one on the way in.
 */
export async function importMeetings(envelope) {
  if (envelope?.export_format !== EXPORT_FORMAT) {
    const got = envelope?.export_format ? `: got "${envelope.export_format}"` : '';
    throw new Error(`Unrecognized export format${got}`);
  }

  const meetings = Array.isArray(envelope.meetings) ? envelope.meetings : [];
  const results = [];

  for (const meeting of meetings) {
    if (!meeting.meeting_id) {
      results.push({ error: 'meeting_id is required' });
      continue;
    }
    try {
      await indexMeeting(buildMeetingDoc({
        meetingId: meeting.meeting_id,
        calendarEventId: meeting.calendar_event_id || null,
        onlineMeetingId: meeting.online_meeting_id || null,
        title: meeting.title,
        organizer: meeting.organizer || '',
        attendees: meeting.attendees || [],
        times: {
          start_time: meeting.start_time || null,
          end_time: meeting.end_time || null,
          duration_minutes: meeting.duration_minutes ?? 0,
          scheduled_start_time: meeting.scheduled_start_time || null,
          scheduled_end_time: meeting.scheduled_end_time || null,
          time_source: meeting.time_source || 'manual',
          transcript_id: meeting.transcript_id || null,
          call_id: meeting.call_id || null,
        },
        summary: meeting.summary || null,
        meetingNotes: meeting.meeting_notes || [],
        actionItems: meeting.action_items || [],
        decisions: meeting.decisions || [],
        topics: meeting.topics || [],
        transcriptText: meeting.transcript_text || null,
        dataSource: meeting.data_source || 'manual',
        syncedAt: meeting.synced_at || null,
        graphAccessible: false,
      }));
      results.push({ meeting_id: meeting.meeting_id, status: 'imported' });
    } catch (err) {
      results.push({ meeting_id: meeting.meeting_id, error: err.message });
    }
  }

  return { results };
}
