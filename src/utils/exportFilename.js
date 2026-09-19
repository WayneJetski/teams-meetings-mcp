const DEFAULT_TIME_ZONE = 'America/Toronto';

/**
 * Build a human-readable export filename: "<scheduled time> <title>
 * [Session N].json". The session suffix appears only when more than one
 * session shares the same booking, so a single-session meeting's filename
 * stays plain.
 *
 * `timeZone` is caller-supplied (the exporting browser's own zone, ideally)
 * since nothing about the meeting's timezone is stored on the document
 * itself — start times are persisted as plain UTC instants.
 */
export function buildExportFilename({ title, scheduledStartTime, startTime, sessionIndex = 1, sessionTotal = 1, timeZone }) {
  const dateLabel = formatDateLabel(scheduledStartTime || startTime, timeZone);
  const safeTitle = sanitizeForFilename(title || 'Untitled Meeting');
  const sessionSuffix = sessionTotal > 1 ? ` [Session ${sessionIndex}]` : '';
  return `${dateLabel} ${safeTitle}${sessionSuffix}.json`;
}

/** "YYYY-MM-DD HHmm" in the given zone, falling back to DEFAULT_TIME_ZONE if it's missing or not a real IANA zone. */
function formatDateLabel(iso, timeZone) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return 'Unknown date';

  const zone = isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);

  const get = (type) => parts.find((p) => p.type === type)?.value;
  // Some ICU builds render midnight as "24" under hour12:false.
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')} ${hour}${get('minute')}`;
}

function isValidTimeZone(timeZone) {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Strips characters invalid across common filesystems and keeps the name a sane length. */
function sanitizeForFilename(title) {
  return title
    .replace(/[/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}
