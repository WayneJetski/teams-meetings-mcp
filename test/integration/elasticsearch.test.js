import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Runs against a real Elasticsearch, so it skips when there is no node to talk
 * to rather than failing. CI supplies one as a service container; locally, set
 * ELASTICSEARCH_URL and ELASTICSEARCH_PASSWORD.
 */

const ES_URL = process.env.ELASTICSEARCH_URL || 'http://localhost:9200';
const ES_PASSWORD = process.env.ELASTICSEARCH_PASSWORD || null;

/**
 * Probe the cluster so the suite can skip with a reason instead of timing out.
 *
 * Returns `false` when reachable, or the message to skip with. Deliberately
 * `false` and not `null`: `describe(name, { skip: null }, fn)` cancels every
 * nested suite instead of running it (Node 22), while `false` behaves.
 */
async function elasticsearchSkipReason() {
  try {
    const headers = ES_PASSWORD
      ? { authorization: `Basic ${Buffer.from(`elastic:${ES_PASSWORD}`).toString('base64')}` }
      : {};
    const res = await fetch(`${ES_URL}/_cluster/health`, {
      headers,
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) return false;
    return `Elasticsearch at ${ES_URL} answered ${res.status} (check ELASTICSEARCH_PASSWORD)`;
  } catch (err) {
    return `no Elasticsearch at ${ES_URL} (${err.message}) — set ELASTICSEARCH_URL to run these`;
  }
}

/**
 * Point the app's config at a throwaway index before importing it.
 *
 * `src/elasticsearch.js` builds its client and reads ES_INDEX at import time, so
 * this has to run first. The unique index name is also the guard that keeps a
 * test run away from a real `meetings` index if someone points ELASTICSEARCH_URL
 * at an install that has one.
 */
function useThrowawayIndex() {
  process.env.SESSION_SECRET ||= 'test-session-secret';
  process.env.AZURE_TENANT_ID ||= '00000000-0000-0000-0000-000000000000';
  process.env.AZURE_CLIENT_ID ||= '11111111-1111-1111-1111-111111111111';
  process.env.AZURE_CLIENT_SECRET ||= 'test-client-secret';

  const index = `meetings-itest-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  process.env.ES_INDEX = index;
  return index;
}

// `false` when Elasticsearch is reachable, otherwise the reason to skip.
const skip = await elasticsearchSkipReason();
const INDEX = useThrowawayIndex();

// Bound in `before`, once the skip decision is made — importing the module
// connects a client, which is pointless when there is nothing to connect to.
let es;
let buildMeetingDoc;
let manualTimes;

/** A complete, valid meeting document with the fields a test cares about. */
function meeting({ id, title = 'Untitled', start, attendees = [], syncedAt, ...rest }) {
  return buildMeetingDoc({
    meetingId: id,
    title,
    organizer: rest.organizer || 'organizer@example.com',
    attendees,
    times: manualTimes({
      start,
      end: new Date(new Date(start).getTime() + 30 * 60_000).toISOString(),
    }),
    summary: rest.summary ?? null,
    actionItems: rest.actionItems || [],
    meetingNotes: rest.meetingNotes || [],
    decisions: rest.decisions || [],
    topics: rest.topics || [],
    transcriptText: rest.transcriptText ?? null,
    dataSource: rest.dataSource || 'transcripts',
    syncedAt,
  });
}

describe('Elasticsearch integration', { skip }, () => {
  before(async () => {
    es = await import('../../src/elasticsearch.js');
    ({ buildMeetingDoc, manualTimes } = await import('../../src/meetingDoc.js'));
    await es.ensureIndex();
  });

  after(async () => {
    if (!es) return;
    await es.client.indices.delete({ index: INDEX }, { ignore: [404] });
  });

  describe('index lifecycle', () => {
    test('creates the index with nested mappings and no replicas', async () => {
      const mapping = await es.client.indices.getMapping({ index: INDEX });
      const props = mapping[INDEX].mappings.properties;

      // These two being `nested` is what forces every query against their
      // contents to be a nested query; the search tests below depend on it.
      assert.equal(props.action_items.type, 'nested');
      assert.equal(props.meeting_notes.type, 'nested');
      assert.equal(props.decisions.type, 'text');
      assert.equal(props.title.type, 'keyword');
      assert.equal(props.title.fields.text.type, 'text');
      assert.equal(props.raw_graph_response.enabled, false);

      const settings = await es.client.indices.getSettings({ index: INDEX });
      // A replica can never be assigned on a single node, which would leave the
      // index permanently yellow.
      assert.equal(settings[INDEX].settings.index.number_of_replicas, '0');
    });

    test('is safe to call again on an existing index', async () => {
      await es.ensureIndex();
      assert.ok(await es.client.indices.exists({ index: INDEX }));
    });
  });

  describe('document round trip', () => {
    before(async () => {
      await es.indexMeeting(meeting({
        id: 'round-trip',
        title: 'Roadmap review',
        start: '2026-02-02T15:00:00.000Z',
        transcriptText: 'the full transcript body',
      }));
    });

    test('reports an indexed meeting as existing', async () => {
      assert.equal(await es.meetingExists('round-trip'), true);
      assert.equal(await es.meetingExists('never-indexed'), false);
    });

    test('withholds the transcript body unless asked', async () => {
      const withheld = await es.getMeeting('round-trip');
      assert.match(withheld.transcript_text, /include_transcript=true/);

      const full = await es.getMeeting('round-trip', true);
      assert.equal(full.transcript_text, 'the full transcript body');
    });

    test('deletes a meeting', async () => {
      await es.indexMeeting(meeting({ id: 'to-delete', start: '2026-02-02T15:00:00.000Z' }));
      await es.deleteMeeting('to-delete');
      assert.equal(await es.meetingExists('to-delete'), false);
    });
  });

  describe('searchMeetings', () => {
    before(async () => {
      await es.indexMeeting(meeting({
        id: 'search-summary',
        title: 'Pricing sync',
        start: '2026-03-01T09:00:00.000Z',
        attendees: ['Ada@example.com', 'grace@example.com'],
        summary: 'We agreed to revisit the enterprise tier.',
        transcriptText: 'a long transcript about margins',
      }));
      await es.indexMeeting(meeting({
        id: 'search-nested',
        title: 'Platform standup',
        start: '2026-03-02T09:00:00.000Z',
        actionItems: [{ title: 'Rotate keys', text: 'Rotate the zygomorphic signing keys', owner: 'ada@example.com' }],
        meetingNotes: [{ title: 'Budget', text: 'The perambulator budget was approved', subpoints: [] }],
      }));
      await es.saveLastSyncTimestamp('2026-03-02T10:00:00.000Z');
    });

    test('matches text in the summary', async () => {
      const hits = await es.searchMeetings({ query: 'enterprise tier' });
      assert.deepEqual(hits.map((h) => h.meeting_id), ['search-summary']);
    });

    // Regression: `action_items` is nested, so naming `action_items.text` in a
    // plain multi_match matched nothing. Every action item was unsearchable.
    test('matches text inside nested action items', async () => {
      const hits = await es.searchMeetings({ query: 'zygomorphic' });
      assert.deepEqual(hits.map((h) => h.meeting_id), ['search-nested']);
    });

    // Regression: same defect on the other nested field.
    test('matches text inside nested meeting notes', async () => {
      const hits = await es.searchMeetings({ query: 'perambulator' });
      assert.deepEqual(hits.map((h) => h.meeting_id), ['search-nested']);
    });

    test('returns highlight fragments from nested matches', async () => {
      const [hit] = await es.searchMeetings({ query: 'zygomorphic' });
      assert.ok(hit.highlights['action_items.text']?.length, 'expected a nested highlight fragment');
      assert.match(hit.highlights['action_items.text'][0], /zygomorphic/);
    });

    test('matches an attendee case-insensitively on a partial address', async () => {
      const hits = await es.searchMeetings({ attendee: 'ADA' });
      assert.deepEqual(hits.map((h) => h.meeting_id), ['search-summary']);
    });

    test('filters by date range on the actual start time', async () => {
      const hits = await es.searchMeetings({
        dateFrom: '2026-03-02T00:00:00.000Z',
        dateTo: '2026-03-02T23:59:59.000Z',
      });
      assert.deepEqual(hits.map((h) => h.meeting_id), ['search-nested']);
    });

    test('never returns the sync-metadata document', async () => {
      const hits = await es.searchMeetings({ limit: 100 });
      assert.ok(hits.length > 0);
      assert.ok(hits.every((h) => h.meeting_id !== '_sync_metadata'));
    });

    test('omits the transcript body from results', async () => {
      const [hit] = await es.searchMeetings({ query: 'enterprise tier' });
      assert.equal(hit.transcript_text, undefined);
      assert.equal(hit.raw_graph_response, undefined);
    });
  });

  describe('getActionItems', () => {
    before(async () => {
      await es.indexMeeting(meeting({
        id: 'actions-1',
        title: 'Release planning',
        start: '2026-04-01T09:00:00.000Z',
        actionItems: [
          { title: 'Cut the release', text: 'Cut the 2.4 release', owner: 'Ada Lovelace' },
          { title: 'Update docs', text: 'Update the upgrade notes', owner: 'Grace Hopper' },
        ],
      }));
      await es.indexMeeting(meeting({
        id: 'actions-none',
        title: 'Coffee chat',
        start: '2026-04-02T09:00:00.000Z',
      }));
    });

    // Regression: this used `exists: { field: 'action_items' }`, which cannot
    // match a nested field, so the tool returned an empty list on every call.
    test('returns action items from meetings that have them', async () => {
      const items = await es.getActionItems({});
      const actions = items.map((i) => i.action);

      assert.ok(actions.includes('Cut the 2.4 release'), `got ${JSON.stringify(actions)}`);
      assert.ok(actions.includes('Update the upgrade notes'));
    });

    test('carries the meeting each item came from', async () => {
      const [item] = await es.getActionItems({ owner: 'Ada' });
      assert.equal(item.meeting_id, 'actions-1');
      assert.equal(item.meeting_title, 'Release planning');
      assert.equal(item.meeting_date, '2026-04-01T09:00:00.000Z');
    });

    test('filters by owner case-insensitively on a partial name', async () => {
      const items = await es.getActionItems({ owner: 'grace' });
      assert.deepEqual(items.map((i) => i.action), ['Update the upgrade notes']);
    });

    test('respects the limit', async () => {
      const items = await es.getActionItems({ limit: 1 });
      assert.equal(items.length, 1);
    });

    test('excludes meetings outside the date range', async () => {
      const items = await es.getActionItems({ dateFrom: '2026-05-01T00:00:00.000Z' });
      assert.deepEqual(items, []);
    });
  });

  describe('getDecisions', () => {
    before(async () => {
      await es.indexMeeting(meeting({
        id: 'decisions-1',
        title: 'Architecture review',
        start: '2026-05-01T09:00:00.000Z',
        decisions: ['Adopt the new ingest pipeline', 'Defer the schema rewrite'],
      }));
    });

    test('returns every decision when unfiltered', async () => {
      const decisions = (await es.getDecisions({})).map((d) => d.decision);
      assert.ok(decisions.includes('Adopt the new ingest pipeline'));
      assert.ok(decisions.includes('Defer the schema rewrite'));
    });

    test('filters to the matching decision, not just the matching meeting', async () => {
      // The query matches the document, so both decisions come back from ES;
      // the per-decision filter is what narrows it to the one that matched.
      const decisions = (await es.getDecisions({ query: 'pipeline' })).map((d) => d.decision);
      assert.deepEqual(decisions, ['Adopt the new ingest pipeline']);
    });
  });

  describe('meetingStats', () => {
    test('aggregates across meetings without counting sync metadata', async () => {
      const stats = await es.meetingStats();

      assert.ok(stats.total_meetings > 0);
      // The metadata document has no meeting_id, so a value_count over that
      // field must never see it.
      const all = await es.client.count({ index: INDEX });
      assert.ok(stats.total_meetings < all.count, 'metadata document must be excluded');

      assert.ok(stats.date_range.earliest);
      assert.ok(stats.date_range.latest);
      assert.ok(stats.data_sources.some((s) => s.source === 'transcripts'));
    });

    // The owners aggregation is nested; a plain terms agg on
    // `action_items.owner` would return no buckets at all.
    test('counts action-item owners through the nested aggregation', async () => {
      const stats = await es.meetingStats();
      const owners = stats.top_action_owners.map((o) => o.owner);

      assert.ok(owners.includes('Ada Lovelace'), `got ${JSON.stringify(owners)}`);
      assert.ok(owners.includes('Grace Hopper'));
    });

    test('counts attendees', async () => {
      const stats = await es.meetingStats();
      // Note the capital: buildMeetingDoc lowercases `organizer` but not
      // `attendees`, and `attendees` is a keyword, so these buckets are
      // case-sensitive and the same person can occupy two of them.
      assert.ok(stats.top_attendees.some((a) => a.name === 'Ada@example.com'));
    });
  });

  describe('sync metadata', () => {
    test('round-trips the sync watermark', async () => {
      await es.saveLastSyncTimestamp('2026-06-01T00:00:00.000Z');
      assert.equal(await es.getLastSyncTimestamp(), '2026-06-01T00:00:00.000Z');
    });

    // The reason updateSyncMetadata uses a merging update rather than index():
    // an outright write would drop the schema version, and every sync would
    // silently reset it and re-run migrations.
    test('writing the watermark preserves the schema version', async () => {
      await es.saveSchemaVersion(7);
      await es.saveLastSyncTimestamp('2026-06-02T00:00:00.000Z');

      assert.equal(await es.getSchemaVersion(), 7);
      assert.equal(await es.getLastSyncTimestamp(), '2026-06-02T00:00:00.000Z');
    });

    test('recording a schema version resets the attempt counter', async () => {
      await es.saveMigrationAttempts(3);
      assert.equal(await es.getMigrationAttempts(), 3);

      await es.saveSchemaVersion(8);
      assert.equal(await es.getMigrationAttempts(), 0);
    });
  });

  describe('scanAllMeetings', () => {
    test('pages past the page size and skips the metadata document', async () => {
      const ids = [];
      for (let i = 0; i < 7; i++) {
        const id = `scan-${String(i).padStart(2, '0')}`;
        ids.push(id);
        // Distinct title and start time per document: identical ones would be
        // duplicates by the deduplication test's definition, and these documents
        // outlive this test in the shared index.
        await es.indexMeeting(meeting({
          id,
          title: `Scan fixture ${i}`,
          start: new Date(Date.UTC(2026, 6, 1, 9, i)).toISOString(),
        }));
      }

      const scanned = await es.scanAllMeetings({ pageSize: 2 });
      const scannedIds = scanned.map((d) => d.meeting_id);

      for (const id of ids) {
        assert.ok(scannedIds.includes(id), `${id} missing from the scan`);
      }
      assert.ok(scanned.every((d) => d.meeting_id), 'metadata document must not be scanned');
    });
  });

  describe('deduplicateMeetings', () => {
    test('keeps the most recently synced of two identical documents', async () => {
      await es.indexMeeting(meeting({
        id: 'dupe-old',
        title: 'Weekly sync',
        start: '2026-08-01T09:00:00.000Z',
        syncedAt: '2026-08-01T10:00:00.000Z',
      }));
      await es.indexMeeting(meeting({
        id: 'dupe-new',
        title: 'Weekly sync',
        start: '2026-08-01T09:00:00.000Z',
        syncedAt: '2026-08-02T10:00:00.000Z',
      }));

      const result = await es.deduplicateMeetings();

      assert.ok(result.deletedIds.includes('dupe-old'), `got ${JSON.stringify(result)}`);
      assert.equal(await es.meetingExists('dupe-new'), true);
      assert.equal(await es.meetingExists('dupe-old'), false);
    });

    // Dedup groups by title + start_time, which predates one document per call
    // session. It is only safe because two sessions of one booking have
    // different *actual* start times — that is what this pins down.
    test('keeps two sessions of the same booking', async () => {
      await es.indexMeeting(meeting({
        id: 'session-first',
        title: 'Recurring standup',
        start: '2026-09-01T09:00:00.000Z',
      }));
      await es.indexMeeting(meeting({
        id: 'session-second',
        title: 'Recurring standup',
        start: '2026-09-01T09:41:00.000Z',
      }));

      await es.deduplicateMeetings();

      assert.equal(await es.meetingExists('session-first'), true);
      assert.equal(await es.meetingExists('session-second'), true);
    });
  });

  describe('healthCheck', () => {
    after(async () => {
      await es.client.indices.putSettings({
        index: INDEX,
        body: { 'index.blocks.read_only_allow_delete': null },
      });
    });

    test('reports ok while writes are accepted', async () => {
      const health = await es.healthCheck();
      assert.equal(health.serviceStatus, 'ok');
      assert.equal(health.writesBlocked, false);
    });

    // A full disk makes Elasticsearch apply this block itself. Cluster health
    // stays green throughout, so this is the only signal callers get.
    test('reports degraded when the index is blocked from writes', async () => {
      await es.client.indices.putSettings({
        index: INDEX,
        body: { 'index.blocks.read_only_allow_delete': true },
      });

      const health = await es.healthCheck();
      assert.equal(health.writesBlocked, true);
      assert.deepEqual(health.blocks, ['read_only_allow_delete']);
      assert.equal(health.serviceStatus, 'degraded');
      assert.equal(health.status, 'green', 'cluster health stays green — that is the point');
    });
  });
});
