/**
 * Get an ISO 8601 date string for N days ago.
 */
export function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

/**
 * Calculate duration in minutes between two ISO date strings.
 */
export function durationMinutes(startIso, endIso) {
  const start = new Date(startIso);
  const end = new Date(endIso);
  return Math.round((end - start) / 60000);
}

/**
 * Return current ISO timestamp.
 */
export function now() {
  return new Date().toISOString();
}
