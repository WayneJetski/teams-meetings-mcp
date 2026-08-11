import { graphGetAll, graphGetText } from './client.js';
import { getCurrentUserId } from './auth.js';
import { parseVtt } from '../utils/vttParser.js';

/**
 * List available transcripts for a meeting.
 *
 * A recurring series accumulates one transcript per occurrence under a single
 * onlineMeetingId, and Graph returns only the first page by default (20). On a
 * daily standup that is roughly four weeks of history, so an unpaged list can
 * omit the very occurrence being matched. `notOlderThan` bounds the page walk
 * to the window the caller actually needs.
 */
export async function listTranscripts(onlineMeetingId, { notOlderThan } = {}) {
  const userId = getCurrentUserId();
  const floorMs = notOlderThan ? new Date(notOlderThan).getTime() : null;

  try {
    return await graphGetAll(
      `/v1.0/users/${userId}/onlineMeetings/${onlineMeetingId}/transcripts`,
      { $top: '50' },
      {
        // Transcripts come back newest-first, so keep paging only while the
        // oldest one seen is still newer than the caller's floor.
        shouldContinue:
          floorMs === null
            ? () => false
            : (items) => {
                const oldest = items[items.length - 1]?.createdDateTime;
                return oldest ? new Date(oldest).getTime() > floorMs : false;
              },
      }
    );
  } catch (err) {
    if (err.message?.includes('404')) return [];
    throw err;
  }
}

/**
 * Fetch and parse a transcript's content.
 * Returns { utterances, full_text } or null if unavailable.
 */
export async function fetchTranscript(onlineMeetingId, transcriptId) {
  const userId = getCurrentUserId();
  const basePath = `/v1.0/users/${userId}/onlineMeetings/${onlineMeetingId}/transcripts/${transcriptId}/content`;
  try {
    let content;
    try {
      // Preferred: speaker-attributed WebVTT (includes <v Speaker> voice tags).
      content = await graphGetText(`${basePath}?$format=text/vtt`, 'text/vtt');
    } catch (err) {
      // A tenant admin can disable speaker attribution. Graph then rejects the
      // attributed text/vtt format with a SpeakerAttributionNotAllowed 403 and
      // requires the unattributed transcript+text format, which is selectable
      // ONLY via the Accept header (not the $format query param). Retry with it.
      if (err.message?.includes('SpeakerAttributionNotAllowed')) {
        content = await graphGetText(basePath, 'application/vnd.microsoft.graph.transcript+text');
      } else {
        throw err;
      }
    }
    return parseVtt(content);
  } catch (err) {
    console.log(JSON.stringify({ level: 'warn', msg: `Failed to fetch transcript ${transcriptId}`, error: err.message }));
    return null;
  }
}

/**
 * Fetch the first available transcript for a meeting.
 */
export async function fetchFirstTranscript(onlineMeetingId) {
  const transcripts = await listTranscripts(onlineMeetingId);
  if (transcripts.length === 0) return null;
  return fetchTranscript(onlineMeetingId, transcripts[0].id);
}

/**
 * Find and fetch the transcript that falls within a specific time window.
 * For recurring meetings, multiple transcripts exist under the same onlineMeetingId;
 * this matches the correct one by comparing createdDateTime to the event window.
 *
 * Always requires the transcript's createdDateTime to fall inside the occurrence
 * window (plus buffer). We deliberately do NOT special-case a single available
 * transcript: a recurring series often has just one transcript early on (or before
 * the current occurrence has been transcribed), and returning it unconditionally
 * would attach an unrelated occurrence's transcript to this one. Returning null
 * instead lets a later sync pick up the correct transcript once it exists.
 */
export async function fetchTranscriptForTimeWindow(onlineMeetingId, eventStart, eventEnd) {
  const windowStart = new Date(eventStart);
  const windowEnd = new Date(eventEnd);
  // Allow a 1-hour buffer before/after the event to account for early joins or late transcription
  const bufferMs = 60 * 60 * 1000;
  const rangeStart = new Date(windowStart.getTime() - bufferMs);
  const rangeEnd = new Date(windowEnd.getTime() + bufferMs);

  // Page back far enough to reach this occurrence, no further.
  const transcripts = await listTranscripts(onlineMeetingId, { notOlderThan: rangeStart });
  if (transcripts.length === 0) return null;

  const match = transcripts.find((t) => {
    const created = new Date(t.createdDateTime);
    return created >= rangeStart && created <= rangeEnd;
  });

  if (match) {
    return fetchTranscript(onlineMeetingId, match.id);
  }

  // No time-window match — skip rather than return an unrelated transcript
  return null;
}
