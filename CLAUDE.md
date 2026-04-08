# Teams Meeting Insights MCP Server

This repository contains a dockerized MCP server that ingests Microsoft Teams
meeting data (AI insights, transcripts) via the Microsoft Graph API, indexes
them in Elasticsearch, and exposes tools for Claude to search meeting history.

## Architecture

- **Two Docker containers**: Elasticsearch 8.x + Node.js MCP server
- **Auth**: OAuth2 authorization code flow via Azure AD — users sign in through the web dashboard
- **Route protection**: All web/API routes require an authenticated session; `/health` and MCP endpoint are public
- **Sync engine**: Cron-scheduled + on-demand ingestion from Graph API (runs only when auth tokens are cached)
- **MCP transport**: Streamable HTTP on `/mcp`
- **Data tiers**: `transcripts` (standard M365), `insights` (Copilot), or `both`

## Key Directories

- `src/` — Application source (ES modules, Node.js 20)
- `src/auth/` — OAuth routes (`/auth/login`, `/auth/callback`, `/auth/logout`) and requireAuth middleware
- `src/graph/` — Microsoft Graph API auth (MSAL ConfidentialClientApplication) and data fetching
- `src/sync/` — Sync scheduler and engine
- `src/mcp/` — MCP server and tool definitions
- `src/api/` — REST endpoints (sync, ingest, search)
- `scripts/start.sh` — Startup script (pull, Docker, MCP config)

## MCP Tools

- `search_meetings` — Full-text search across meeting data
- `get_meeting` — Full meeting details by ID
- `get_action_items` — Action items filtered by owner/date
- `get_decisions` — Decisions filtered by keyword/date
- `meeting_stats` — Aggregated meeting statistics

## Running

```bash
./scripts/start.sh   # pulls latest, starts Docker, configures MCP
```

Or manually:
```bash
cp .env.example .env  # configure Azure credentials + SESSION_SECRET
docker compose up -d
```

Then open http://localhost:4005 and sign in with Microsoft.

## Environment Variables

**Required:** `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `SESSION_SECRET`

**Optional:** `GRAPH_DATA_TIER`, `SYNC_CRON`

## Skills

### Teams Meeting Insights (`.claude/skills/teams-meeting-insights.md`)

Retrieves and analyzes Microsoft Teams meeting AI insights, summaries,
transcripts, and action items via the Microsoft Graph API.

See `README.md` for full setup instructions and API permission requirements.
