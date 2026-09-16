/**
 * Matching transcripts to a calendar occurrence.
 *
 * Kept free of Graph/Elasticsearch imports so the window rules are testable on
 * their own.
 */

// A transcript can start slightly before the scheduled start (early join) or
// run past the scheduled end, so matching needs slack on both sides.
export const WINDOW_BUFFER_MS = 60 * 60 * 1000;

/**
 * Select every transcript whose session falls inside an occurrence's window,
 * oldest session first.
 *
 * Graph returns the collection ordered by transcript id rather than by date, so
 * ordering is imposed here and never assumed of the input. A booking held twice
 * yields more than one entry.
 */
export function transcriptsInWindow(transcripts, eventStart, eventEnd) {
  if (!eventStart || !eventEnd) return [];

  const rangeStart = new Date(eventStart).getTime() - WINDOW_BUFFER_MS;
  const rangeEnd = new Date(eventEnd).getTime() + WINDOW_BUFFER_MS;

  return transcripts
    .filter((t) => {
      const created = new Date(t.createdDateTime).getTime();
      return created >= rangeStart && created <= rangeEnd;
    })
    .sort((a, b) => a.createdDateTime.localeCompare(b.createdDateTime));
}
