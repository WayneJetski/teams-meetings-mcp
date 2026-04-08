import { getDecisions } from '../../elasticsearch.js';

export const definition = {
  name: 'get_decisions',
  description:
    'Get decisions made in meetings, optionally filtered by date range or keyword. Use this to find what was decided and when.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Keyword to filter decisions',
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
        description: 'Max results (default 20)',
      },
    },
  },
};

export async function handler(params) {
  const items = await getDecisions({
    query: params.query,
    dateFrom: params.date_from,
    dateTo: params.date_to,
    limit: params.limit || 20,
  });

  if (items.length === 0) {
    return { content: [{ type: 'text', text: 'No decisions found matching your criteria.' }] };
  }

  return {
    content: [{ type: 'text', text: JSON.stringify(items, null, 2) }],
  };
}
