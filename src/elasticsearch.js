import { Client } from '@elastic/elasticsearch';
import config from './config.js';
import { buildEsClientOptions } from './es-client-options.js';
import { interpretBlocks, summariseDisk, overallStatus } from './health.js';

const client = new Client(
  buildEsClientOptions({
    url: config.elasticsearch.url,
    username: config.elasticsearch.username,
    password: config.elasticsearch.password,
    maxRetries: config.elasticsearch.maxRetries,
    requestTimeout: config.elasticsearch.requestTimeout,
  })
);
const INDEX = config.elasticsearch.index;

const MEETINGS_MAPPING = {
  properties: {
    meeting_id: { type: 'keyword' },
    calendar_event_id: { type: 'keyword' },
    online_meeting_id: { type: 'keyword' },
    transcript_id: { type: 'keyword' },
    call_id: { type: 'keyword' },
    title: { type: 'keyword', fields: { text: { type: 'text' } } },
    organizer: { type: 'keyword' },
    attendees: { type: 'keyword' },

    // Actual call session times; a booking held twice produces two documents
    // with distinct start_time values under one scheduled window.
    start_time: { type: 'date' },
    end_time: { type: 'date' },
    duration_minutes: { type: 'integer' },
    scheduled_start_time: { type: 'date' },
    scheduled_end_time: { type: 'date' },
    time_source: { type: 'keyword' },

    summary: { type: 'text' },
    meeting_notes: {
      type: 'nested',
      properties: {
        title: { type: 'text' },
        text: { type: 'text' },
        subpoints: { type: 'text' },
      },
    },
    action_items: {
      type: 'nested',
      properties: {
        title: { type: 'text' },
        text: { type: 'text' },
        owner: { type: 'keyword', fields: { text: { type: 'text' } } },
      },
    },
    decisions: { type: 'text', fields: { keyword: { type: 'keyword' } } },
    topics: { type: 'keyword' },

    transcript_text: { type: 'text' },

    data_source: { type: 'keyword' },
    synced_at: { type: 'date' },
    raw_graph_response: { type: 'object', enabled: false },

    // Lives on the sync-metadata document, not on meetings. Declared so it is
    // not left to dynamic mapping. doc_type and last_successful_sync are
    // deliberately absent: they predate this mapping and are already mapped
    // dynamically, and redeclaring doc_type as a keyword would conflict.
    schema_version: { type: 'integer' },
    migration_attempts: { type: 'integer' },
  },
};

export async function waitForReady(maxAttempts = 30, intervalMs = 2000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const health = await client.cluster.health({ wait_for_status: 'yellow', timeout: '5s' });
      if (health.status === 'green' || health.status === 'yellow') {
        console.log(JSON.stringify({ level: 'info', msg: `Elasticsearch ready`, status: health.status }));
        return;
      }
    } catch (err) {
      const statusCode = err?.meta?.statusCode;
      if (statusCode === 401 || statusCode === 403) {
        // Distinguish an auth mismatch from "still starting up" so a wrong
        // ES_SECRET is diagnosable instead of an opaque timeout. The status
        // code is safe to log; the credential itself is never included.
        console.log(JSON.stringify({
          level: 'error',
          msg: 'Elasticsearch rejected credentials — check ES_SECRET matches the elastic user password',
          statusCode,
          attempt,
          maxAttempts,
        }));
      } else {
        console.log(JSON.stringify({ level: 'info', msg: `Waiting for Elasticsearch`, attempt, maxAttempts }));
      }
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('Elasticsearch did not become ready in time');
}

export async function ensureIndex() {
  await waitForReady();
  const exists = await client.indices.exists({ index: INDEX });
  if (!exists) {
    await client.indices.create({
      index: INDEX,
      // Single-node cluster: a replica can never be assigned to a second
      // node, so number_of_replicas: 1 (the default) leaves the index
      // permanently yellow instead of green.
      body: { settings: { number_of_replicas: 0 }, mappings: MEETINGS_MAPPING },
    });
    console.log(JSON.stringify({ level: 'info', msg: `Created index "${INDEX}"` }));
    return;
  }

  // Adding fields to an existing mapping is non-breaking, and an index created
  // by an older version otherwise leaves new fields dynamically typed.
  await client.indices.putMapping({ index: INDEX, body: MEETINGS_MAPPING });
}

export async function indexMeeting(doc) {
  await client.index({
    index: INDEX,
    id: doc.meeting_id,
    body: doc,
    refresh: 'wait_for',
  });
}

export async function meetingExists(meetingId) {
  return client.exists({ index: INDEX, id: meetingId });
}

export async function deleteMeeting(meetingId) {
  await client.delete({ index: INDEX, id: meetingId, refresh: 'wait_for' });
}

/**
 * Walk every meeting document, oldest id first.
 * Paged with search_after so the whole index is safe to iterate without a
 * scroll context.
 */
export async function scanAllMeetings({ pageSize = 500 } = {}) {
  const docs = [];
  let searchAfter;

  for (;;) {
    const result = await client.search({
      index: INDEX,
      size: pageSize,
      query: { exists: { field: 'meeting_id' } },
      sort: [{ meeting_id: 'asc' }],
      ...(searchAfter ? { search_after: searchAfter } : {}),
    });

    const hits = result.hits.hits;
    if (hits.length === 0) return docs;

    docs.push(...hits.map((h) => h._source));
    searchAfter = hits[hits.length - 1].sort;
  }
}

const SYNC_META_ID = '_sync_metadata';

export async function getLastSyncTimestamp() {
  try {
    const result = await client.get({ index: INDEX, id: SYNC_META_ID });
    return result._source?.last_successful_sync || null;
  } catch (err) {
    if (err.meta?.statusCode === 404) return null;
    throw err;
  }
}

/**
 * Merge fields into the sync-metadata document.
 * An outright index() would drop whatever else lives there — the schema
 * version, in particular, which every sync would otherwise reset.
 */
async function updateSyncMetadata(fields) {
  await client.update({
    index: INDEX,
    id: SYNC_META_ID,
    doc: { doc_type: 'sync_metadata', ...fields },
    doc_as_upsert: true,
    refresh: 'wait_for',
  });
}

export async function saveLastSyncTimestamp(isoTimestamp) {
  await updateSyncMetadata({ last_successful_sync: isoTimestamp });
}

/**
 * Schema version of the indexed data, used to run a migration exactly once per
 * install. Absent on an index written before versioning began.
 */
export async function getSchemaVersion() {
  try {
    const result = await client.get({ index: INDEX, id: SYNC_META_ID });
    return result._source?.schema_version ?? 0;
  } catch (err) {
    if (err.meta?.statusCode === 404) return 0;
    throw err;
  }
}

export async function saveSchemaVersion(version) {
  await updateSyncMetadata({ schema_version: version, migration_attempts: 0 });
}

/**
 * How many times a migration to the current version has been attempted without
 * fully succeeding. Bounds the retry of documents Graph will never resolve.
 */
export async function getMigrationAttempts() {
  try {
    const result = await client.get({ index: INDEX, id: SYNC_META_ID });
    return result._source?.migration_attempts ?? 0;
  } catch (err) {
    if (err.meta?.statusCode === 404) return 0;
    throw err;
  }
}

export async function saveMigrationAttempts(attempts) {
  await updateSyncMetadata({ migration_attempts: attempts });
}

/**
 * Flatten highlight fragments from nested inner_hits into the flat
 * `highlights` shape callers already expect from top-level fields.
 */
function nestedHighlights(hit) {
  const merged = {};
  for (const innerHit of Object.values(hit.inner_hits || {})) {
    for (const nested of innerHit.hits?.hits || []) {
      for (const [field, fragments] of Object.entries(nested.highlight || {})) {
        (merged[field] ||= []).push(...fragments);
      }
    }
  }
  return merged;
}

export async function searchMeetings({ query, attendee, dateFrom, dateTo, limit = 10 }) {
  const must = [];
  const filter = [];

  if (query) {
    // action_items and meeting_notes are `nested`, which means their contents
    // live in separate Lucene documents. A multi_match naming `action_items.text`
    // silently matches nothing — it has to be reached through a nested query, or
    // the text of every action item and meeting note is unsearchable.
    must.push({
      bool: {
        minimum_should_match: 1,
        should: [
          {
            multi_match: {
              query,
              fields: ['summary^3', 'title.text^2', 'transcript_text', 'decisions'],
              type: 'best_fields',
              fuzziness: 'AUTO',
            },
          },
          {
            nested: {
              path: 'action_items',
              score_mode: 'max',
              query: {
                multi_match: {
                  query,
                  fields: ['action_items.text', 'action_items.title'],
                  type: 'best_fields',
                  fuzziness: 'AUTO',
                },
              },
              inner_hits: { _source: false, highlight: { fields: { 'action_items.text': { fragment_size: 200 } } } },
            },
          },
          {
            nested: {
              path: 'meeting_notes',
              score_mode: 'max',
              query: {
                multi_match: {
                  query,
                  fields: ['meeting_notes.text', 'meeting_notes.title', 'meeting_notes.subpoints'],
                  type: 'best_fields',
                  fuzziness: 'AUTO',
                },
              },
              inner_hits: { _source: false, highlight: { fields: { 'meeting_notes.text': { fragment_size: 200 } } } },
            },
          },
        ],
      },
    });
  }

  if (attendee) {
    filter.push({
      bool: {
        should: [
          { wildcard: { attendees: { value: `*${attendee.toLowerCase()}*`, case_insensitive: true } } },
          { wildcard: { organizer: { value: `*${attendee.toLowerCase()}*`, case_insensitive: true } } },
        ],
      },
    });
  }

  if (dateFrom || dateTo) {
    const range = {};
    if (dateFrom) range.gte = dateFrom;
    if (dateTo) range.lte = dateTo;
    filter.push({ range: { start_time: range } });
  }

  const body = {
    size: limit,
    sort: [{ start_time: 'desc' }],
    query: {
      bool: {
        must: must.length ? must : [{ match_all: {} }],
        filter,
        must_not: [{ term: { doc_type: 'sync_metadata' } }],
      },
    },
    // Nested fields cannot be highlighted from the top level; their fragments
    // come back on the inner_hits declared above and are merged in below.
    highlight: {
      fields: {
        summary: { fragment_size: 200 },
        transcript_text: { fragment_size: 200 },
        decisions: { fragment_size: 200 },
      },
    },
  };

  const result = await client.search({ index: INDEX, body });
  return result.hits.hits.map((hit) => ({
    meeting_id: hit._id,
    score: hit._score,
    ...hit._source,
    transcript_text: undefined, // omit full transcript from search results
    raw_graph_response: undefined,
    highlights: { ...(hit.highlight || {}), ...nestedHighlights(hit) },
  }));
}

export async function getMeeting(meetingId, includeTranscript = false) {
  try {
    const result = await client.get({ index: INDEX, id: meetingId });
    const doc = result._source;
    if (!includeTranscript) {
      doc.transcript_text = doc.transcript_text ? '[available — request with include_transcript=true]' : null;
    }
    delete doc.raw_graph_response;
    return doc;
  } catch (err) {
    if (err.meta?.statusCode === 404) return null;
    throw err;
  }
}

export async function getActionItems({ owner, dateFrom, dateTo, limit = 20 }) {
  const filter = [];

  if (dateFrom || dateTo) {
    const range = {};
    if (dateFrom) range.gte = dateFrom;
    if (dateTo) range.lte = dateTo;
    filter.push({ range: { start_time: range } });
  }

  const body = {
    size: 100,
    sort: [{ start_time: 'desc' }],
    query: {
      bool: {
        // `exists` never matches a nested field: the parent document does not
        // carry it, so this returned no meetings at all and the tool answered
        // an empty list on every call.
        must: [{ nested: { path: 'action_items', query: { match_all: {} }, score_mode: 'none' } }],
        filter,
        must_not: [{ term: { doc_type: 'sync_metadata' } }],
      },
    },
    _source: ['meeting_id', 'title', 'start_time', 'action_items'],
  };

  const result = await client.search({ index: INDEX, body });

  const items = [];
  for (const hit of result.hits.hits) {
    const src = hit._source;
    if (!src.action_items) continue;
    for (const ai of src.action_items) {
      if (owner && ai.owner && !ai.owner.toLowerCase().includes(owner.toLowerCase())) continue;
      items.push({
        action: ai.text || ai.title,
        owner: ai.owner || 'Unassigned',
        meeting_title: src.title,
        meeting_date: src.start_time,
        meeting_id: hit._id,
      });
    }
  }

  return items.slice(0, limit);
}

export async function getDecisions({ query, dateFrom, dateTo, limit = 20 }) {
  const must = [];
  const filter = [];

  if (query) {
    must.push({ match: { decisions: query } });
  }

  if (dateFrom || dateTo) {
    const range = {};
    if (dateFrom) range.gte = dateFrom;
    if (dateTo) range.lte = dateTo;
    filter.push({ range: { start_time: range } });
  }

  const body = {
    size: 100,
    sort: [{ start_time: 'desc' }],
    query: {
      bool: {
        must: must.length ? must : [{ exists: { field: 'decisions' } }],
        filter,
        must_not: [{ term: { doc_type: 'sync_metadata' } }],
      },
    },
    _source: ['meeting_id', 'title', 'start_time', 'decisions'],
  };

  const result = await client.search({ index: INDEX, body });

  const items = [];
  for (const hit of result.hits.hits) {
    const src = hit._source;
    if (!src.decisions) continue;
    for (const d of src.decisions) {
      if (query && !d.toLowerCase().includes(query.toLowerCase())) continue;
      items.push({
        decision: d,
        meeting_title: src.title,
        meeting_date: src.start_time,
        meeting_id: hit._id,
      });
    }
  }

  return items.slice(0, limit);
}

export async function meetingStats() {
  const body = {
    size: 0,
    query: { bool: { must_not: [{ term: { doc_type: 'sync_metadata' } }] } },
    aggs: {
      total: { value_count: { field: 'meeting_id' } },
      date_range: { stats: { field: 'start_time' } },
      top_attendees: { terms: { field: 'attendees', size: 10 } },
      top_topics: { terms: { field: 'topics', size: 10 } },
      top_action_owners: {
        nested: { path: 'action_items' },
        aggs: { owners: { terms: { field: 'action_items.owner', size: 10 } } },
      },
      data_sources: { terms: { field: 'data_source' } },
    },
  };

  const result = await client.search({ index: INDEX, body });
  const aggs = result.aggregations;

  return {
    total_meetings: aggs.total.value,
    date_range: {
      earliest: aggs.date_range.min_as_string || null,
      latest: aggs.date_range.max_as_string || null,
    },
    top_attendees: aggs.top_attendees.buckets.map((b) => ({ name: b.key, count: b.doc_count })),
    top_topics: aggs.top_topics.buckets.map((b) => ({ topic: b.key, count: b.doc_count })),
    top_action_owners: aggs.top_action_owners.owners.buckets.map((b) => ({ owner: b.key, count: b.doc_count })),
    data_sources: aggs.data_sources.buckets.map((b) => ({ source: b.key, count: b.doc_count })),
  };
}

export async function listMeetings({ limit = 20, offset = 0 } = {}) {
  const body = {
    from: offset,
    size: limit,
    sort: [{ start_time: 'desc' }],
    query: { bool: { must_not: [{ term: { doc_type: 'sync_metadata' } }] } },
    _source: ['meeting_id', 'online_meeting_id', 'call_id', 'title', 'organizer', 'attendees', 'start_time', 'end_time', 'duration_minutes', 'scheduled_start_time', 'scheduled_end_time', 'time_source', 'summary', 'action_items', 'decisions', 'topics', 'data_source', 'synced_at'],
  };

  const result = await client.search({ index: INDEX, body });
  return {
    total: typeof result.hits.total === 'number' ? result.hits.total : result.hits.total.value,
    meetings: result.hits.hits.map((hit) => ({ meeting_id: hit._id, ...hit._source })),
  };
}

/**
 * Whether anything is currently stopping writes to the meetings index.
 *
 * A full disk trips Elasticsearch's flood-stage watermark and applies
 * `read_only_allow_delete`, after which every sync write fails while cluster
 * health stays green — the failure is otherwise invisible to callers.
 */
export async function getWriteBlocks() {
  const settings = await client.indices.getSettings({ index: INDEX, name: 'index.blocks.*' });
  return interpretBlocks(settings);
}

export async function getDiskUsage() {
  const rows = await client.cat.allocation({ format: 'json', bytes: 'b' });
  return summariseDisk(rows);
}

export async function healthCheck() {
  const health = await client.cluster.health();

  // Block and disk state are diagnostic, not load-bearing: a failure to read
  // them must not turn a healthy server into an unhealthy one.
  let writeBlocks = { writesBlocked: false, blocks: [] };
  let disk = null;
  try {
    [writeBlocks, disk] = await Promise.all([getWriteBlocks(), getDiskUsage()]);
  } catch (err) {
    console.log(JSON.stringify({ level: 'warn', msg: 'Could not read index blocks or disk usage', error: err.message }));
  }

  return {
    status: health.status,
    numberOfNodes: health.number_of_nodes,
    writesBlocked: writeBlocks.writesBlocked,
    blocks: writeBlocks.blocks,
    disk,
    serviceStatus: overallStatus({ writesBlocked: writeBlocks.writesBlocked, disk }),
  };
}

/**
 * Find and remove duplicate meeting documents.
 * Groups by title + start_time and keeps the most recently synced document
 * in each group.
 */
export async function deduplicateMeetings() {
  // Scroll through all meetings, grouped by title + start_time
  const body = {
    size: 0,
    query: { bool: { must_not: [{ term: { doc_type: 'sync_metadata' } }] } },
    aggs: {
      duplicates: {
        composite: {
          size: 1000,
          sources: [
            { title: { terms: { field: 'title' } } },
            { start_time: { terms: { field: 'start_time' } } },
          ],
        },
        aggs: {
          doc_ids: {
            top_hits: {
              size: 100,
              sort: [{ synced_at: 'desc' }],
              _source: ['meeting_id', 'synced_at'],
            },
          },
        },
      },
    },
  };

  const result = await client.search({ index: INDEX, body });
  const buckets = result.aggregations.duplicates.buckets;

  const idsToDelete = [];
  for (const bucket of buckets) {
    const hits = bucket.doc_ids.hits.hits;
    if (hits.length <= 1) continue;

    // Keep the first (most recently synced), delete the rest
    for (let i = 1; i < hits.length; i++) {
      idsToDelete.push(hits[i]._id);
    }
  }

  if (idsToDelete.length === 0) {
    return { deleted: 0, message: 'No duplicates found' };
  }

  // Bulk delete
  const bulkBody = idsToDelete.flatMap((id) => [
    { delete: { _index: INDEX, _id: id } },
  ]);
  await client.bulk({ body: bulkBody, refresh: 'wait_for' });

  console.log(JSON.stringify({ level: 'info', msg: `Deduplicated meetings`, deleted: idsToDelete.length }));
  return { deleted: idsToDelete.length, deletedIds: idsToDelete };
}

export { client };
