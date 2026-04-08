import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import * as searchMeetings from './tools/searchMeetings.js';
import * as getMeetingTool from './tools/getMeeting.js';
import * as getActionItems from './tools/getActionItems.js';
import * as getDecisions from './tools/getDecisions.js';
import * as meetingStatsTool from './tools/meetingStats.js';

const tools = [searchMeetings, getMeetingTool, getActionItems, getDecisions, meetingStatsTool];

export function createMcpServer() {
  const server = new McpServer({
    name: 'teams-meeting-insights',
    version: '1.0.0',
  });

  // Register each tool
  for (const tool of tools) {
    const def = tool.definition;
    const props = def.inputSchema.properties || {};
    const required = def.inputSchema.required || [];

    // Build zod schema from JSON schema properties
    const zodShape = {};
    for (const [key, prop] of Object.entries(props)) {
      let field;
      if (prop.type === 'string') field = z.string();
      else if (prop.type === 'number') field = z.number();
      else if (prop.type === 'boolean') field = z.boolean();
      else field = z.any();

      if (prop.description) field = field.describe(prop.description);
      if (!required.includes(key)) field = field.optional();

      zodShape[key] = field;
    }

    server.tool(def.name, def.description, zodShape, async (params) => {
      try {
        return await tool.handler(params);
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    });
  }

  return server;
}

// Map of session ID -> { transport, server } for active Streamable HTTP sessions
const sessions = new Map();

export function handleStreamableHttp(mcpPath) {
  return {
    async handleRequest(req, res) {
      const sessionId = req.headers['mcp-session-id'];

      if (req.method === 'POST') {
        // Check for existing session
        if (sessionId && sessions.has(sessionId)) {
          const entry = sessions.get(sessionId);
          await entry.transport.handleRequest(req, res);
          return;
        }

        // New session — create transport and server
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, { transport, server });
          },
        });

        transport.onclose = () => {
          const id = transport.sessionId;
          if (id) sessions.delete(id);
        };

        const server = createMcpServer();
        await server.connect(transport);
        await transport.handleRequest(req, res);
        return;
      }

      if (req.method === 'GET') {
        // SSE stream for server-initiated messages
        if (!sessionId || !sessions.has(sessionId)) {
          res.status(400).json({ error: 'Invalid or missing session ID' });
          return;
        }
        const entry = sessions.get(sessionId);
        await entry.transport.handleRequest(req, res);
        return;
      }

      if (req.method === 'DELETE') {
        if (sessionId && sessions.has(sessionId)) {
          const entry = sessions.get(sessionId);
          await entry.transport.handleRequest(req, res);
          sessions.delete(sessionId);
          return;
        }
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      res.status(405).json({ error: 'Method not allowed' });
    },
  };
}
