import { exportMeetings } from '../../exportImport.js';

export const definition = {
  name: 'export_meeting',
  description:
    'Export a meeting as a portable JSON document another Teams Meeting Insights install can import — for sharing a meeting with someone who was never a Graph-visible attendee (e.g. via Slack or email). Returns the JSON as text; send it on with another tool, or hand it to the user to pass along.',
  inputSchema: {
    type: 'object',
    properties: {
      meeting_id: {
        type: 'string',
        description: 'The meeting ID to export',
      },
    },
    required: ['meeting_id'],
  },
};

export async function handler(params) {
  const envelope = await exportMeetings([params.meeting_id]);

  if (!envelope.meetings.length) {
    return { content: [{ type: 'text', text: `Meeting not found: ${params.meeting_id}` }], isError: true };
  }

  return {
    content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
  };
}
