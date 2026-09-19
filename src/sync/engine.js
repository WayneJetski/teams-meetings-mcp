import config from '../config.js';
import { discoverMeetings, getOnlineMeetingByJoinUrl, extractAttendees } from '../graph/meetings.js';
import { fetchAiInsights } from '../graph/insights.js';
import { listTranscripts, fetchTranscript } from '../graph/transcripts.js';
import { restoreAuthenticatedUser } from '../graph/auth.js';
import { indexMeeting, meetingExists, getLastSyncTimestamp, saveLastSyncTimestamp, getLastRunInfo, saveLastRunInfo, getWriteBlocks } from '../elasticsearch.js';
import { sessionTimes, buildMeetingDoc } from '../meetingDoc.js';
import { resolveLookbackDays, computeWatermark, classifyUncaptured } from './syncWindow.js';
import { buildSessionId } from './sessionId.js';
import { transcriptsInWindow } from './transcriptWindow.js';
import { now } from '../utils/timestamps.js';

/** A short, human-facing reason for a Graph error, for the sync status dashboard. */
function describeError(err) {
  const statusCode = err.meta?.statusCode || err.statusCode;
  if (statusCode === 403) return 'No permission to access this meeting';
  if (statusCode === 404) return 'Meeting not found (expired or deleted)';
  return 'Error fetching this meeting';
}

// Track sync state
let syncInProgress = false;
let lastSyncError = null;
let meetingsIndexed = 0;

export async function getSyncStatus() {
  const lastSync = await getLastSyncTimestamp();
  const lastRun = await getLastRunInfo();
  return {
    lastSync,
    lastRun,
    syncInProgress,
    lastSyncError,
    meetingsIndexed,
    giveUpDays: config.sync.giveUpDays,
  };
}

export async function runSync(lookbackDays) {
  if (syncInProgress) {
    console.log(JSON.stringify({ level: 'warn', msg: 'Sync already in progress, skipping' }));
    return { skipped: true };
  }

  syncInProgress = true;
  lastSyncError = null;
  const dataTier = config.graph.dataTier;

  // A blocked index fails every single write. Without this the run walks the
  // whole window and logs one cluster_block_exception per meeting, burying the
  // one fact that matters.
  try {
    const { writesBlocked, blocks } = await getWriteBlocks();
    if (writesBlocked) {
      lastSyncError = `Elasticsearch is refusing writes (${blocks.join(', ')})`;
      syncInProgress = false;
      await saveLastRunInfo({ ranAt: now(), blocked: true, error: lastSyncError });
      console.log(JSON.stringify({
        level: 'error',
        msg: 'Sync aborted — Elasticsearch is refusing writes. Free disk space; Elasticsearch releases a flood-stage block itself once usage drops below the high watermark.',
        blocks,
      }));
      return { blocked: true, blocks };
    }
  } catch (err) {
    console.log(JSON.stringify({ level: 'warn', msg: 'Could not check index write blocks, continuing', error: err.message }));
  }

  // Rehydrate the Graph user from the persisted token cache so a sync works on
  // a cold start, without waiting for an interactive sign-in. Callers that
  // reach runSync directly (POST /sync) get this too.
  await restoreAuthenticatedUser();

  // Incremental sync: if we have a persisted sync timestamp and no explicit
  // lookbackDays override, only look back to the last sync (plus a 1-day
  // overlap buffer to catch late-arriving transcripts).
  // When lookbackDays is explicitly provided (force sync), ignore the
  // persisted timestamp and use the full window.
  const overrideDays = lookbackDays || config.sync.lookbackDays;
  const effectiveDays = resolveLookbackDays({
    explicitLookbackDays: lookbackDays,
    configuredLookbackDays: overrideDays,
    lastSuccessfulSync: lookbackDays ? null : await getLastSyncTimestamp(),
    nowMs: Date.now(),
  });

  console.log(JSON.stringify({
    level: 'info',
    msg: 'Starting sync',
    lookbackDays: effectiveDays,
    dataTier,
    incremental: effectiveDays < overrideDays,
  }));

  let synced = 0;
  let skipped = 0;
  let errors = 0;

  // One entry per occurrence this run could not capture anything for.
  // Classified after the loop (see classifyUncaptured in ./syncWindow.js) into
  // what should still hold the watermark back for retry versus what's been
  // given a fair chance and won't ever resolve.
  const uncaptured = [];

  // Cache online meeting lookups by joinWebUrl to avoid redundant API calls
  // for recurring meetings that share the same join link.
  const onlineMeetingCache = new Map();
  // Transcript listings keyed by onlineMeetingId, shared across every
  // occurrence of a series discovered in this run.
  const transcriptCache = new Map();
  const wantsTranscripts = dataTier === 'transcripts' || dataTier === 'both';

  try {
    const events = await discoverMeetings(effectiveDays);
    console.log(JSON.stringify({ level: 'info', msg: `Discovered ${events.length} calendar events with online meetings` }));

    for (const event of events) {
      const eventStart = event.start?.dateTime ? new Date(event.start.dateTime + 'Z').toISOString() : null;

      // Record an occurrence we could not index, for classifyUncaptured to
      // sort out once the whole run's outcome is known.
      const markUncaptured = (reason) => uncaptured.push({ eventStart, title: event.subject, reason });

      try {
        const joinWebUrl = event.onlineMeeting?.joinUrl;
        if (!joinWebUrl) {
          // An online meeting with no join URL is malformed and will never
          // resolve; retrying it forever would pin the window open.
          skipped++;
          continue;
        }

        // Resolve the online meeting, using cache for recurring meetings
        let onlineMeeting = onlineMeetingCache.get(joinWebUrl);
        if (onlineMeeting === undefined) {
          onlineMeeting = await getOnlineMeetingByJoinUrl(joinWebUrl);
          onlineMeetingCache.set(joinWebUrl, onlineMeeting);
        }

        if (!onlineMeeting) {
          console.log(JSON.stringify({ level: 'warn', msg: `Could not resolve online meeting for "${event.subject}"` }));
          markUncaptured('Could not resolve the online meeting');
          skipped++;
          continue;
        }

        const onlineMeetingId = onlineMeeting.id;
        const eventEnd = event.end?.dateTime ? new Date(event.end.dateTime + 'Z').toISOString() : null;

        // One list call per online meeting, not per occurrence: every
        // occurrence of a recurring series resolves to the same
        // onlineMeetingId and returns the same collection.
        let allTranscripts = transcriptCache.get(onlineMeetingId);
        if (allTranscripts === undefined) {
          allTranscripts = wantsTranscripts ? (await listTranscripts(onlineMeetingId)).transcripts : [];
          transcriptCache.set(onlineMeetingId, allTranscripts);
        }

        const sessions = transcriptsInWindow(allTranscripts, eventStart, eventEnd);

        // With no transcript the occurrence still gets one document, keyed on
        // its scheduled start, so an insights-only tier is not dropped.
        const sessionList = sessions.length > 0 ? sessions : [null];
        let captured = 0;

        for (const [sessionIndex, transcriptMeta] of sessionList.entries()) {
          const times = sessionTimes({
            transcript: transcriptMeta,
            scheduledStart: eventStart,
            scheduledEnd: eventEnd,
          });
          const sessionId = buildSessionId(onlineMeetingId, times.start_time || eventStart);

          // Existence is checked per session rather than per occurrence, so a
          // second session transcribed after an earlier sync ran is still
          // picked up by a later run.
          if (await meetingExists(sessionId)) {
            captured++;
            skipped++;
            continue;
          }

          const doc = buildMeetingDoc({
            meetingId: sessionId,
            calendarEventId: event.id,
            onlineMeetingId,
            title: event.subject,
            organizer: event.organizer?.emailAddress?.address || '',
            attendees: extractAttendees(event),
            times,
            dataSource: dataTier,
          });

          // Graph exposes aiInsights per online meeting, not per call session,
          // so they attach to the occurrence's first session only. Copying them
          // onto every session would duplicate the same action items across
          // documents.
          if ((dataTier === 'insights' || dataTier === 'both') && sessionIndex === 0) {
            try {
              const insights = await fetchAiInsights(onlineMeetingId);
              if (insights) {
                doc.summary = insights.summary;
                doc.meeting_notes = insights.meetingNotes;
                doc.action_items = insights.actionItems;
                doc.decisions = insights.decisions;
                doc.topics = insights.topics;
                doc.raw_graph_response.insights = insights.raw;
                if (dataTier === 'insights') doc.data_source = 'ai_insights';
              }
            } catch (err) {
              console.log(JSON.stringify({ level: 'warn', msg: `AI insights unavailable for "${event.subject}"`, error: err.message }));
            }
          }

          if (transcriptMeta) {
            try {
              const transcript = await fetchTranscript(onlineMeetingId, transcriptMeta.id);
              if (transcript) {
                doc.transcript_text = transcript.full_text;

                if (dataTier === 'transcripts') doc.data_source = 'transcript';
                if (dataTier === 'both' && doc.summary) doc.data_source = 'both';
              }
            } catch (err) {
              console.log(JSON.stringify({ level: 'warn', msg: `Transcript unavailable for "${event.subject}"`, error: err.message }));
            }
          }

          // Only index if we got some useful data
          if (doc.summary || doc.transcript_text || doc.action_items.length > 0) {
            await indexMeeting(doc);
            captured++;
            synced++;
            meetingsIndexed++;
            console.log(JSON.stringify({
              level: 'info',
              msg: `Indexed session "${doc.title}" (${doc.start_time})`,
              sessionId,
              sessionIndex,
              sessionsInOccurrence: sessionList.length,
            }));
          } else {
            console.log(JSON.stringify({ level: 'info', msg: `No data available for "${event.subject}" (${doc.start_time}), skipping index` }));
            skipped++;
          }
        }

        // The watermark only holds back occurrences that produced nothing at
        // all. A session that has not been transcribed yet is indistinguishable
        // from one that will never exist, so a captured occurrence is treated
        // as done and later sessions are picked up by the lookback overlap.
        if (captured === 0) markUncaptured('No transcript available');
      } catch (err) {
        errors++;
        markUncaptured(describeError(err));
        const errorDetail = err.message || err.body?.error?.reason || err.meta?.body?.error?.reason || String(err);
        console.log(JSON.stringify({
          level: 'error',
          msg: `Error processing event "${event.subject}"`,
          error: errorDetail,
          errorType: err.constructor?.name,
          statusCode: err.meta?.statusCode || err.statusCode,
        }));
      }
    }

    const { oldestUncapturedStart, abandoned, isOutage, failures } = classifyUncaptured({
      uncaptured,
      totalEvents: events.length,
      nowMs: Date.now(),
      giveUpDays: config.sync.giveUpDays,
    });

    const watermark = computeWatermark({
      oldestUncapturedStart,
      nowMs: Date.now(),
      maxLookbackDays: overrideDays,
    });
    await saveLastSyncTimestamp(watermark);

    // Surface a held-back watermark at warn level: it means occurrences are
    // still missing, which was previously invisible in the logs.
    const isHeldBack = Boolean(oldestUncapturedStart);
    console.log(JSON.stringify({
      level: isHeldBack ? 'warn' : 'info',
      msg: isOutage
        ? 'Sync complete — every occurrence failed, treating as an outage and holding the watermark unconditionally'
        : isHeldBack
          ? 'Sync complete with uncaptured occurrences — watermark held back for retry'
          : 'Sync complete',
      synced,
      skipped,
      errors,
      uncaptured: uncaptured.length,
      abandoned,
      isOutage,
      oldestUncapturedStart,
      watermark,
    }));
    await saveLastRunInfo({
      ranAt: now(),
      synced,
      skipped,
      errors,
      uncaptured: uncaptured.length,
      abandoned,
      isOutage,
      oldestUncapturedStart,
      watermark,
      failures,
    });
    return { synced, skipped, errors, uncaptured: uncaptured.length, abandoned, isOutage, watermark };
  } catch (err) {
    lastSyncError = err.message;
    await saveLastRunInfo({ ranAt: now(), failed: true, error: err.message });
    console.log(JSON.stringify({ level: 'error', msg: 'Sync failed', error: err.message }));
    throw err;
  } finally {
    syncInProgress = false;
  }
}
