import {
  getSchemaVersion,
  saveSchemaVersion,
  getMigrationAttempts,
  saveMigrationAttempts,
} from '../elasticsearch.js';
import { migrateSessionIds } from './migrateSessionIds.js';
import { decideMigrationOutcome, RECORD, GIVE_UP, WAIT } from './migrationOutcome.js';

/**
 * Schema version of the data this code writes.
 *
 * 1 — one document per calendar occurrence per day; times are the booking.
 * 2 — one document per call session; times are the actual call, with the
 *     booking kept in scheduled_start_time/scheduled_end_time.
 */
export const CURRENT_SCHEMA_VERSION = 2;

/**
 * Attempts before the version is recorded despite unresolved documents.
 *
 * Some documents are permanently unresolvable — Graph answers 403 for a meeting
 * the user has lost access to, or 400 for an id it no longer accepts — and
 * retrying those on every boot would mean a full index scan and a Graph call per
 * meeting, forever. The leftovers stay legacy-keyed, which is harmless: nothing
 * outside the migration parses a document id.
 */
export const MAX_MIGRATION_ATTEMPTS = 5;

/**
 * Bring an existing index up to the current schema, once.
 *
 * A completed run records the version, after which startup costs a single
 * document read. A run that could not resolve every document does NOT record
 * it, so the next start retries the remainder — the migration is idempotent and
 * leaves anything it cannot answer for untouched.
 *
 * Never throws: a failed migration must not stop the server, or an install
 * whose Graph auth has lapsed could not reach the dashboard to sign in again.
 */
export async function runPendingMigrations() {
  let version;
  try {
    version = await getSchemaVersion();
  } catch (err) {
    console.log(JSON.stringify({ level: 'error', msg: 'Could not read schema version — skipping migrations', error: err.message }));
    return;
  }

  if (version >= CURRENT_SCHEMA_VERSION) return;

  console.log(JSON.stringify({ level: 'info', msg: 'Migrating index to session-keyed documents', from: version, to: CURRENT_SCHEMA_VERSION }));

  try {
    const { summary } = await migrateSessionIds({ apply: true });
    const attempts = await getMigrationAttempts();
    const outcome = decideMigrationOutcome({
      complete: summary.complete,
      reason: summary.reason,
      attempts,
      maxAttempts: MAX_MIGRATION_ATTEMPTS,
    });

    if (outcome === RECORD) {
      await saveSchemaVersion(CURRENT_SCHEMA_VERSION);
      console.log(JSON.stringify({ level: 'info', msg: 'Migration complete', schemaVersion: CURRENT_SCHEMA_VERSION }));
      return;
    }

    if (outcome === WAIT) return;

    if (outcome === GIVE_UP) {
      await saveSchemaVersion(CURRENT_SCHEMA_VERSION);
      console.log(JSON.stringify({
        level: 'warn',
        msg: 'Migration giving up on unresolved documents — they stay occurrence-keyed. Re-run scripts/migrate-session-ids.sh by hand if the cause is fixed.',
        attempts: attempts + 1,
        unresolved: (summary.skipped || 0) + (summary.errors || 0),
      }));
      return;
    }

    await saveMigrationAttempts(attempts + 1);
    console.log(JSON.stringify({
      level: 'warn',
      msg: 'Migration incomplete — will retry on next start',
      attempts: attempts + 1,
      maxAttempts: MAX_MIGRATION_ATTEMPTS,
      skipped: summary.skipped,
      errors: summary.errors,
    }));
  } catch (err) {
    console.log(JSON.stringify({ level: 'error', msg: 'Migration failed — will retry on next start', error: err.message }));
  }
}
