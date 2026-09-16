/**
 * Document IDs for meeting sessions.
 *
 * A calendar occurrence is not the unit of ingest: one occurrence can hold
 * several call sessions (a meeting run twice on the same invite, or a
 * transcription stopped and restarted). Keying on the occurrence date collapses
 * those into a single document and silently discards every session but one, so
 * the key is the session's own start instant instead.
 */

/**
 * Compact an ISO instant to a filesystem/URL-safe key segment.
 * 2026-09-15T13:00:30.874Z -> 20260915T130030Z
 */
export function compactInstant(iso) {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

/**
 * Build the document ID for one call session.
 *
 * `sessionStartIso` is the transcript's createdDateTime where a transcript
 * exists, and the occurrence's scheduled start otherwise (insights-only tier,
 * or a document whose transcript has aged out of Graph retention).
 */
export function buildSessionId(onlineMeetingId, sessionStartIso) {
  return `${onlineMeetingId}_${compactInstant(sessionStartIso)}`;
}

/**
 * Build the pre-session-key document ID: one document per occurrence per day.
 * Retained only so the migration can recognise and replace legacy documents.
 */
export function buildLegacyInstanceId(onlineMeetingId, eventStartIso) {
  const dateTag = eventStartIso ? eventStartIso.slice(0, 10) : 'unknown';
  return `${onlineMeetingId}_${dateTag}`;
}

const LEGACY_SUFFIX = /_\d{4}-\d{2}-\d{2}$/;

export function isLegacyId(id) {
  return LEGACY_SUFFIX.test(id);
}
