import { isLegacyId } from './sessionId.js';
import { transcriptsInWindow } from './transcriptWindow.js';

export const REKEY = 'rekey';
export const REBUILD = 'rebuild';
export const FALLBACK = 'fallback';
export const SKIP = 'skip';
export const NOOP = 'noop';

// What Graph was able to say about the document's online meeting.
export const GRAPH_OK = 'ok';
export const GRAPH_NOT_FOUND = 'not_found';
export const GRAPH_FAILED = 'failed';

/**
 * Decide what the session-id migration should do with one document.
 *
 * - rekey:    exactly one transcript matches the window, so the stored text is
 *             unambiguously that session's and only its identity and actual
 *             times need attaching. No content is re-downloaded.
 * - rebuild:  several sessions share the window. Which one the stored text came
 *             from is unknowable, so every session is re-fetched and the legacy
 *             document is replaced wholesale.
 * - fallback: Graph positively reports the meeting as gone (Teams drops
 *             transcripts and the onlineMeeting object after its retention
 *             window) or lists no transcript matching the window. Neither can
 *             improve on a later run, so the scheduled start becomes the key and
 *             the times stay marked as scheduled.
 * - skip:     Graph could not answer — auth, throttling, network. Distinct from
 *             not_found on purpose: treating a failed call as "expired" would
 *             re-key the whole index onto scheduled times and destroy actual
 *             times that are still retrievable. The document is left legacy-keyed
 *             for a later run.
 * - noop:     already session-keyed.
 */
export function classifyDoc(doc, transcripts, { graphStatus }) {
  if (!isLegacyId(doc.meeting_id)) return { action: NOOP, sessions: [] };
  if (graphStatus === GRAPH_FAILED) return { action: SKIP, sessions: [] };
  if (graphStatus === GRAPH_NOT_FOUND) return { action: FALLBACK, sessions: [] };

  const sessions = transcriptsInWindow(transcripts, doc.start_time, doc.end_time);
  if (sessions.length === 0) return { action: FALLBACK, sessions: [] };
  if (sessions.length === 1) return { action: REKEY, sessions };
  return { action: REBUILD, sessions };
}
