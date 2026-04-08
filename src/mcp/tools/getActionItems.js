import { getActionItems } from '../../elasticsearch.js';

export const definition = {
  name: 'get_action_items',
  description:
    'Get action items from meetings, optionally filtered by owner or date range. Use this to find what tasks were assigned to someone, or all outstanding action items from recent meetings.',
  inputSchema: {
    type: 'object',
    properties: {
      owner: {
        type: 'string',
        description: 'Filter by action item owner name',
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
  const items = await getActionItems({
    owner: params.owner,
    dateFrom: params.date_from,
    dateTo: params.date_to,
    limit: params.limit || 20,
  });

  if (items.length === 0) {
    return { content: [{ type: 'text', text: 'No action items found matching your criteria.' }] };
  }

  return {
    content: [{ type: 'text', text: JSON.stringify(items, null, 2) }],
  };
}
