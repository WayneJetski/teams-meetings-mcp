import { graphGet, graphGetText } from './client.js';
import { getCurrentUserId } from './auth.js';
import { parseVtt } from '../utils/vttParser.js';

/**
 * List available transcripts for a meeting.
 */
export async function listTranscripts(onlineMeetingId) {
  const userId = getCurrentUserId();
  try {
    const result = await graphGet(
      `/v1.0/users/${userId}/onlineMeetings/${onlineMeetingId}/transcripts`
    );
    return result.value || [];
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
  try {
    const vttContent = await graphGetText(
      `/v1.0/users/${userId}/onlineMeetings/${onlineMeetingId}/transcripts/${transcriptId}/content?$format=text/vtt`,
      'text/vtt'
    );
    return parseVtt(vttContent);
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
 * Falls back to fetchFirstTranscript when only one transcript exists.
 */
export async function fetchTranscriptForTimeWindow(onlineMeetingId, eventStart, eventEnd) {
  const transcripts = await listTranscripts(onlineMeetingId);
  if (transcripts.length === 0) return null;
  if (transcripts.length === 1) {
    return fetchTranscript(onlineMeetingId, transcripts[0].id);
  }

  const windowStart = new Date(eventStart);
  const windowEnd = new Date(eventEnd);
  // Allow a 1-hour buffer before/after the event to account for early joins or late transcription
  const bufferMs = 60 * 60 * 1000;
  const rangeStart = new Date(windowStart.getTime() - bufferMs);
  const rangeEnd = new Date(windowEnd.getTime() + bufferMs);

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
