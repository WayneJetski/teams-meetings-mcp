import { graphGetAll, graphGetText } from './client.js';
import { getCurrentUserId } from './auth.js';
import { parseVtt } from '../utils/vttParser.js';

/**
 * List every transcript recorded under an online meeting.
 *
 * A recurring series accumulates one transcript per call session under a single
 * onlineMeetingId, and a session that is stopped and restarted adds another.
 * Graph orders this collection by transcript id, NOT by date, so the page walk
 * cannot stop early on a date heuristic and callers must not assume any date
 * ordering of the result.
 *
 * Resolves to `{ found, transcripts }`. `found: false` means Graph positively
 * reported the meeting as gone — past its retention window the onlineMeeting
 * object itself 404s. Any other failure throws, so a caller never mistakes a
 * transient error for an empty history.
 */
export async function listTranscripts(onlineMeetingId) {
  const userId = getCurrentUserId();

  try {
    const transcripts = await graphGetAll(
      `/v1.0/users/${userId}/onlineMeetings/${onlineMeetingId}/transcripts`,
      { $top: '50' },
      { maxPages: 20 }
    );
    return { found: true, transcripts };
  } catch (err) {
    if (err.statusCode === 404) return { found: false, transcripts: [] };
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
