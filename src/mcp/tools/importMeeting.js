import { importMeetings } from '../../exportImport.js';

export const definition = {
  name: 'import_meeting',
  description:
    "Import a meeting export produced by another Teams Meeting Insights install's export_meeting tool. Indexes it here so it's searchable, marked as not accessible via this install's own Graph API access.",
  inputSchema: {
    type: 'object',
    properties: {
      export_data: {
        type: 'string',
        description: 'The full JSON text produced by export_meeting',
      },
    },
    required: ['export_data'],
  },
};

export async function handler(params) {
  let envelope;
  try {
    envelope = JSON.parse(params.export_data);
  } catch (err) {
    return { content: [{ type: 'text', text: `export_data is not valid JSON: ${err.message}` }], isError: true };
  }

  try {
    const { results } = await importMeetings(envelope);
    return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Import failed: ${err.message}` }], isError: true };
  }
}
