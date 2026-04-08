import { Client } from '@elastic/elasticsearch';
import config from './config.js';

const client = new Client({
  node: config.elasticsearch.url,
  maxRetries: 5,
  requestTimeout: 30000,
});
const INDEX = config.elasticsearch.index;

const MEETINGS_MAPPING = {
  properties: {
    meeting_id: { type: 'keyword' },
    calendar_event_id: { type: 'keyword' },
    online_meeting_id: { type: 'keyword' },
    title: { type: 'keyword', fields: { text: { type: 'text' } } },
    organizer: { type: 'keyword' },
    attendees: { type: 'keyword' },
    start_time: { type: 'date' },
    end_time: { type: 'date' },
    duration_minutes: { type: 'integer' },

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
    } catch {
      console.log(JSON.stringify({ level: 'info', msg: `Waiting for Elasticsearch`, attempt, maxAttempts }));
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
      body: { mappings: MEETINGS_MAPPING },
    });
    console.log(JSON.stringify({ level: 'info', msg: `Created index "${INDEX}"` }));
  }
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

export async function saveLastSyncTimestamp(isoTimestamp) {
  await client.index({
    index: INDEX,
    id: SYNC_META_ID,
    body: { last_successful_sync: isoTimestamp, doc_type: 'sync_metadata' },
    refresh: 'wait_for',
  });
}

export async function searchMeetings({ query, attendee, dateFrom, dateTo, limit = 10 }) {
  const must = [];
  const filter = [];

  if (query) {
    must.push({
      multi_match: {
        query,
        fields: ['summary^3', 'title.text^2', 'transcript_text', 'decisions', 'action_items.text', 'meeting_notes.text'],
        type: 'best_fields',
        fuzziness: 'AUTO',
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
    highlight: {
      fields: {
        summary: { fragment_size: 200 },
        transcript_text: { fragment_size: 200 },
        'action_items.text': { fragment_size: 200 },
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
    highlights: hit.highlight || {},
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
        must: [{ exists: { field: 'action_items' } }],
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
    _source: ['meeting_id', 'online_meeting_id', 'title', 'organizer', 'attendees', 'start_time', 'end_time', 'duration_minutes', 'summary', 'action_items', 'decisions', 'topics', 'data_source', 'synced_at'],
  };

  const result = await client.search({ index: INDEX, body });
  return {
    total: typeof result.hits.total === 'number' ? result.hits.total : result.hits.total.value,
    meetings: result.hits.hits.map((hit) => ({ meeting_id: hit._id, ...hit._source })),
  };
}

export async function healthCheck() {
  const health = await client.cluster.health();
  return { status: health.status, numberOfNodes: health.number_of_nodes };
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
