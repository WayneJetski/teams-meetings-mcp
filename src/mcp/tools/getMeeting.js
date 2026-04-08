import { getMeeting } from '../../elasticsearch.js';

export const definition = {
  name: 'get_meeting',
  description:
    'Get the full details of a specific meeting by its ID, including complete summary, all action items, notes, decisions, and optionally the full transcript.',
  inputSchema: {
    type: 'object',
    properties: {
      meeting_id: {
        type: 'string',
        description: 'The meeting ID',
      },
      include_transcript: {
        type: 'boolean',
        description: 'Whether to include the full transcript text (default false)',
      },
    },
    required: ['meeting_id'],
  },
};

export async function handler(params) {
  const meeting = await getMeeting(params.meeting_id, params.include_transcript || false);

  if (!meeting) {
    return { content: [{ type: 'text', text: `Meeting not found: ${params.meeting_id}` }] };
  }

  return {
    content: [{ type: 'text', text: JSON.stringify(meeting, null, 2) }],
  };
}
