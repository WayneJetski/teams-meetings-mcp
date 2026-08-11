import config from '../config.js';
import { discoverMeetings, getOnlineMeetingByJoinUrl, extractAttendees } from '../graph/meetings.js';
import { fetchAiInsights } from '../graph/insights.js';
import { fetchTranscriptForTimeWindow } from '../graph/transcripts.js';
import { restoreAuthenticatedUser } from '../graph/auth.js';
import { indexMeeting, meetingExists, getLastSyncTimestamp, saveLastSyncTimestamp } from '../elasticsearch.js';
import { durationMinutes, now } from '../utils/timestamps.js';
import { resolveLookbackDays, computeWatermark } from './syncWindow.js';

// Track sync state
let syncInProgress = false;
let lastSyncError = null;
let meetingsIndexed = 0;

export async function getSyncStatus() {
  const lastSync = await getLastSyncTimestamp();
  return {
    lastSync,
    syncInProgress,
    lastSyncError,
    meetingsIndexed,
  };
}

/**
 * Build a deterministic document ID for a meeting instance.
 * Combines the online meeting ID with the event start date so each
 * occurrence of a recurring meeting gets its own document.
 */
function buildInstanceId(onlineMeetingId, eventStartIso) {
  const dateTag = eventStartIso ? eventStartIso.slice(0, 10) : 'unknown';
  return `${onlineMeetingId}_${dateTag}`;
}

export async function runSync(lookbackDays) {
  if (syncInProgress) {
    console.log(JSON.stringify({ level: 'warn', msg: 'Sync already in progress, skipping' }));
    return { skipped: true };
  }

  syncInProgress = true;
  lastSyncError = null;
  const dataTier = config.graph.dataTier;

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

  // Start time of the oldest occurrence this run could not capture. The
  // watermark is held back to it so the next run retries instead of stepping
  // over the gap. See computeWatermark in ./syncWindow.js.
  let oldestUncapturedStart = null;
  let uncaptured = 0;

  // Cache online meeting lookups by joinWebUrl to avoid redundant API calls
  // for recurring meetings that share the same join link.
  const onlineMeetingCache = new Map();

  try {
    const events = await discoverMeetings(effectiveDays);
    console.log(JSON.stringify({ level: 'info', msg: `Discovered ${events.length} calendar events with online meetings` }));

    for (const event of events) {
      const eventStart = event.start?.dateTime ? new Date(event.start.dateTime + 'Z').toISOString() : null;

      // Record an occurrence we could not index, so the watermark stays behind
      // it. ISO-8601 UTC strings from toISOString() compare correctly with <.
      const markUncaptured = () => {
        uncaptured++;
        if (eventStart && (!oldestUncapturedStart || eventStart < oldestUncapturedStart)) {
          oldestUncapturedStart = eventStart;
        }
      };

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
          markUncaptured();
          skipped++;
          continue;
        }

        const onlineMeetingId = onlineMeeting.id;
        const eventEnd = event.end?.dateTime ? new Date(event.end.dateTime + 'Z').toISOString() : null;
        const instanceId = buildInstanceId(onlineMeetingId, eventStart);

        // Check if this specific instance is already indexed
        if (await meetingExists(instanceId)) {
          skipped++;
          continue;
        }

        // Build the meeting document
        const doc = {
          meeting_id: instanceId,
          calendar_event_id: event.id,
          online_meeting_id: onlineMeetingId,
          title: event.subject || 'Untitled Meeting',
          organizer: event.organizer?.emailAddress?.address?.toLowerCase() || '',
          attendees: extractAttendees(event),
          start_time: eventStart,
          end_time: eventEnd,
          duration_minutes: 0,
          summary: null,
          meeting_notes: [],
          action_items: [],
          decisions: [],
          topics: [],
          transcript_text: null,
          data_source: dataTier,
          synced_at: now(),
          raw_graph_response: {},
        };

        if (doc.start_time && doc.end_time) {
          doc.duration_minutes = durationMinutes(doc.start_time, doc.end_time);
        }

        // Fetch data based on configured tier
        if (dataTier === 'insights' || dataTier === 'both') {
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

        if (dataTier === 'transcripts' || dataTier === 'both') {
          try {
            const transcript = await fetchTranscriptForTimeWindow(onlineMeetingId, eventStart, eventEnd);
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
          synced++;
          meetingsIndexed++;
          console.log(JSON.stringify({ level: 'info', msg: `Indexed meeting "${doc.title}" (${eventStart})`, instanceId }));
        } else {
          console.log(JSON.stringify({ level: 'info', msg: `No data available for "${event.subject}" (${eventStart}), skipping index` }));
          markUncaptured();
          skipped++;
        }
      } catch (err) {
        errors++;
        markUncaptured();
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
      msg: isHeldBack
        ? 'Sync complete with uncaptured occurrences — watermark held back for retry'
        : 'Sync complete',
      synced,
      skipped,
      errors,
      uncaptured,
      oldestUncapturedStart,
      watermark,
    }));
    return { synced, skipped, errors, uncaptured, watermark };
  } catch (err) {
    lastSyncError = err.message;
    console.log(JSON.stringify({ level: 'error', msg: 'Sync failed', error: err.message }));
    throw err;
  } finally {
    syncInProgress = false;
  }
}
