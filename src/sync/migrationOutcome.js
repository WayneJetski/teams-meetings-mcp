export const RECORD = 'record';
export const RETRY = 'retry';
export const GIVE_UP = 'give_up';
export const WAIT = 'wait';

/**
 * Decide what to do with the schema version after a migration run.
 *
 * - record:  everything resolved; stamp the version and stop running.
 * - wait:    a precondition is unmet (not signed in yet). Retry indefinitely
 *            without consuming the attempt budget, since no document was even
 *            examined.
 * - retry:   some documents are unresolved and budget remains.
 * - give_up: budget exhausted. Stamp the version anyway so startup stops paying
 *            for a full scan, and leave the stragglers occurrence-keyed.
 */
export function decideMigrationOutcome({ complete, reason, attempts, maxAttempts }) {
  if (complete) return RECORD;
  if (reason === 'not_authenticated') return WAIT;
  return attempts + 1 >= maxAttempts ? GIVE_UP : RETRY;
}
