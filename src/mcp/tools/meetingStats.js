import { meetingStats } from '../../elasticsearch.js';

export const definition = {
  name: 'meeting_stats',
  description:
    'Get statistics about indexed meetings — total count, date range, most frequent attendees, most common topics.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
};

export async function handler() {
  const stats = await meetingStats();
  return {
    content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }],
  };
}
