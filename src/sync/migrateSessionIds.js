import { listTranscripts, fetchTranscript } from '../graph/transcripts.js';
import { restoreAuthenticatedUser, isAuthenticated } from '../graph/auth.js';
import { scanAllMeetings, indexMeeting, deleteMeeting } from '../elasticsearch.js';
import { sessionTimes, buildMeetingDoc } from '../meetingDoc.js';
import { isLegacyId } from './sessionId.js';
import {
  classifyDoc,
  REKEY, REBUILD, FALLBACK, SKIP, NOOP,
  GRAPH_OK, GRAPH_NOT_FOUND, GRAPH_FAILED,
} from './migrationPlan.js';

/**
 * Migration from occurrence-keyed documents (`<onlineMeetingId>_<YYYY-MM-DD>`)
 * to session-keyed documents (`<onlineMeetingId>_<session start>`).
 *
 * Safe to re-run: legacy and session keys are distinguishable, so an already
 * migrated document is a no-op. `complete` in the summary reports whether every
 * legacy document was resolved; anything Graph could not answer for is left
 * untouched and retried on a later run rather than being degraded.
 *
 * Teams drops transcripts and the onlineMeeting object itself after its
 * retention window, so for older documents the index is the only surviving
 * copy. Nothing is deleted before its replacement is written.
 */

function migratedDoc(doc, transcript) {
  const times = sessionTimes({
    transcript,
    // A legacy document's start_time/end_time are the booking, which is exactly
    // what the scheduled fields should now hold.
    scheduledStart: doc.scheduled_start_time || doc.start_time,
    scheduledEnd: doc.scheduled_end_time || doc.end_time,
  });

  // Rebuilt rather than spread, so a migrated document is byte-for-byte the
  // shape the sync engine writes rather than a legacy record with fields bolted
  // on. The id is derived from the session start, not carried over.
  return buildMeetingDoc({
    onlineMeetingId: doc.online_meeting_id,
    calendarEventId: doc.calendar_event_id,
    title: doc.title,
    organizer: doc.organizer,
    attendees: doc.attendees,
    times,
    summary: doc.summary,
    meetingNotes: doc.meeting_notes,
    actionItems: doc.action_items,
    decisions: doc.decisions,
    topics: doc.topics,
    transcriptText: doc.transcript_text,
    dataSource: doc.data_source,
    rawGraphResponse: doc.raw_graph_response,
  });
}

export async function migrateSessionIds({ apply = false } = {}) {
  await restoreAuthenticatedUser();

  const docs = await scanAllMeetings();
  const legacy = docs.filter((d) => isLegacyId(d.meeting_id));

  // A fresh install, or one already migrated, needs neither Graph nor writes.
  if (legacy.length === 0) {
    return { summary: { scanned: docs.length, legacy: 0, complete: true, apply }, actions: [] };
  }

  // Without Graph, every document would classify as "expired" and be re-keyed
  // onto its booking, discarding actual times that are still retrievable and
  // sessions that are still recoverable. Refuse the run instead.
  if (!(await isAuthenticated())) {
    console.log(JSON.stringify({ level: 'warn', msg: 'Session-id migration skipped — no authenticated Graph user. Sign in via the dashboard; it runs on the next start.' }));
    return { summary: { scanned: docs.length, legacy: legacy.length, complete: false, reason: 'not_authenticated', apply }, actions: [] };
  }

  const byOnlineMeeting = new Map();
  for (const doc of legacy) {
    if (!byOnlineMeeting.has(doc.online_meeting_id)) byOnlineMeeting.set(doc.online_meeting_id, []);
    byOnlineMeeting.get(doc.online_meeting_id).push(doc);
  }

  const summary = {
    scanned: docs.length,
    legacy: legacy.length,
    rekeyed: 0,
    rebuilt: 0,
    recoveredSessions: 0,
    fallback: 0,
    retentionExpired: 0,
    skipped: 0,
    errors: 0,
    apply,
  };
  const actions = [];

  for (const [onlineMeetingId, group] of byOnlineMeeting) {
    let transcripts = [];
    let graphStatus = GRAPH_OK;

    try {
      const result = await listTranscripts(onlineMeetingId);
      transcripts = result.transcripts;
      if (!result.found) {
        graphStatus = GRAPH_NOT_FOUND;
        summary.retentionExpired += group.length;
      }
    } catch (err) {
      graphStatus = GRAPH_FAILED;
      console.log(JSON.stringify({ level: 'warn', msg: 'Transcript listing failed — leaving documents legacy-keyed for a later run', onlineMeetingId, error: err.message }));
    }

    for (const doc of group) {
      const { action, sessions } = classifyDoc(doc, transcripts, { graphStatus });
      if (action === NOOP) continue;
      if (action === SKIP) {
        summary.skipped++;
        continue;
      }

      const replacements = [];

      if (action === REKEY) {
        replacements.push(migratedDoc(doc, sessions[0]));
        summary.rekeyed++;
      } else if (action === FALLBACK) {
        replacements.push(migratedDoc(doc, null));
        summary.fallback++;
      } else {
        for (const session of sessions) {
          const replacement = migratedDoc(doc, session);
          replacement.transcript_text = null;

          if (apply) {
            const transcript = await fetchTranscript(onlineMeetingId, session.id);
            if (!transcript) {
              summary.errors++;
              console.log(JSON.stringify({ level: 'error', msg: 'Session content unavailable, leaving legacy document in place', meetingId: doc.meeting_id, transcriptId: session.id }));
              replacements.length = 0;
              break;
            }
            replacement.transcript_text = transcript.full_text;
          }
          replacements.push(replacement);
        }
        if (replacements.length === 0) continue;
        summary.rebuilt++;
        summary.recoveredSessions += sessions.length - 1;
      }

      actions.push({
        action,
        from: doc.meeting_id,
        to: replacements.map((r) => r.meeting_id),
        title: doc.title,
        scheduled: doc.start_time,
      });

      if (!apply) continue;

      for (const replacement of replacements) {
        await indexMeeting(replacement);
      }
      // Only after every replacement is durable, and never when the key did not
      // actually move.
      if (!replacements.some((r) => r.meeting_id === doc.meeting_id)) {
        await deleteMeeting(doc.meeting_id);
      }
    }
  }

  summary.complete = summary.skipped === 0 && summary.errors === 0;

  console.log(JSON.stringify({ level: 'info', msg: apply ? 'Session-id migration applied' : 'Session-id migration dry run', ...summary }));
  return { summary, actions };
}
