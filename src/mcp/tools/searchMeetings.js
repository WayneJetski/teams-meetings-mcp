import { searchMeetings } from '../../elasticsearch.js';

export const definition = {
  name: 'search_meetings',
  description:
    'Search across all indexed Teams meeting data — summaries, transcripts, action items, decisions, and notes. Use this to find what was discussed, decided, or assigned in meetings.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Natural language or keyword search',
      },
      attendee: {
        type: 'string',
        description: 'Filter meetings by attendee name or email',
      },
      date_from: {
        type: 'string',
        description: 'ISO 8601 — meetings after this date',
      },
      date_to: {
        type: 'string',
        description: 'ISO 8601 — meetings before this date',
      },
      limit: {
        type: 'number',
        description: 'Max results (default 10)',
      },
    },
    required: ['query'],
  },
};

export async function handler(params) {
  const results = await searchMeetings({
    query: params.query,
    attendee: params.attendee,
    dateFrom: params.date_from,
    dateTo: params.date_to,
    limit: params.limit || 10,
  });

  if (results.length === 0) {
    return { content: [{ type: 'text', text: 'No meetings found matching your search.' }] };
  }

  const formatted = results.map((m) => ({
    meeting_id: m.meeting_id,
    title: m.title,
    date: m.start_time,
    duration_minutes: m.duration_minutes,
    attendees: m.attendees,
    summary: m.summary,
    action_items: m.action_items,
    decisions: m.decisions,
    topics: m.topics,
    highlights: m.highlights,
    relevance_score: m.score,
  }));

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(formatted, null, 2) +
          '\n\nNote: Full transcripts are omitted from search results. Use get_meeting with the meeting_id for full details.',
      },
    ],
  };
}
