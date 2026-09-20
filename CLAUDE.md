# Teams Meeting Insights MCP Server

This repository contains a dockerized MCP server that ingests Microsoft Teams
meeting data (AI insights, transcripts) via the Microsoft Graph API, indexes
them in Elasticsearch, and exposes tools for Claude to search meeting history.

## Architecture

- **Two Docker containers**: Elasticsearch 8.x + Node.js MCP server
- **Elasticsearch security**: Auth enabled; the app connects as the `elastic` user with `ES_SECRET` (auto-generated in `.env`, backfilled on update via `scripts/lib/es-security.sh`). ES has no host port — it's reachable only inside the Docker network. Use `scripts/es-tunnel.sh` for on-demand direct access.
- **Auth**: OAuth2 authorization code flow via Azure AD — users sign in through the web dashboard
- **Route protection**: All web/API routes require an authenticated session; `/health` and MCP endpoint are public.
  The boundary is middleware order in `src/app.js`: everything registered
  before `requireAuth` is public, everything after it is not, so moving a route
  across that line changes who can reach it. `test/routes.test.js` pins the
  current split down by request. `src/app.js` builds the app with no process
  side effects (no listener, migrations or scheduler) and `src/index.js` owns
  startup, which is what lets the tests import it.
- **Health**: `/health` reports `ok`, `degraded` or `unhealthy`. Degraded means
  the index is refusing writes, or a node has crossed a disk watermark — a full
  disk trips Elasticsearch's flood-stage watermark and applies
  `read_only_allow_delete`, after which every sync write fails while cluster
  health stays green. Degraded still answers 200, because reads, the MCP tools
  and the dashboard all keep working; only ingest is impaired. A sync aborts
  immediately when writes are blocked rather than failing once per meeting, and
  the reason surfaces in `/sync/status`. Elasticsearch releases a flood-stage
  block itself once usage drops back below the high watermark. Interpretation
  rules are in `src/health.js` as pure, dependency-free functions.
- **Sync engine**: Cron-scheduled + on-demand ingestion from Graph API (runs only
  when auth tokens are cached). Incremental runs derive their window from a
  persisted watermark that is held back at any occurrence that couldn't be
  indexed, so gaps retry instead of sliding out of range. Window arithmetic
  lives in `src/sync/syncWindow.js` as pure, dependency-free functions.
- **Document shape**: `src/meetingDoc.js` is the single writer-side definition.
  The sync engine, the session-id migration, and `POST /ingest` all assemble
  documents with `buildMeetingDoc`, so no path can write a partial record.
  Reads go through `src/elasticsearch.js`. `time_source` distinguishes
  `transcript` (times from the call), `scheduled_fallback` (times from the
  booking, transcript unavailable) and `manual` (pushed in through the ingest
  API).
- **Document identity**: one document per *call session*, keyed
  `<onlineMeetingId>_<session start>`. A booking held twice produces two
  sessions under one calendar occurrence, so an occurrence-level key would
  collapse them. `start_time`/`end_time`/`duration_minutes` report the actual
  call (the transcript's `createdDateTime`/`endDateTime`), with the booking kept
  in `scheduled_start_time`/`scheduled_end_time` and `time_source` recording
  which of the two the primary fields came from. Graph orders a meeting's
  transcript collection by transcript id, **not** by date, so no caller may
  assume date ordering. Key construction is in `src/sync/sessionId.js` and
  window matching in `src/sync/transcriptWindow.js`, both dependency-free.
- **Schema migrations**: `src/sync/migrations.js` runs pending migrations once
  per install at startup, after the HTTP listener (so the dashboard stays
  reachable for sign-in) and before the scheduler. Gated on `schema_version` in
  the sync-metadata document, so a migrated install pays one document read per
  boot. A run that cannot resolve every document does not record the version and
  retries next start, bounded by `MAX_MIGRATION_ATTEMPTS` so a permanently
  unresolvable meeting (Graph 403/400) cannot force a full scan on every boot;
  an unauthenticated install waits indefinitely instead of spending that budget.
  Migrations never throw into startup.
- **Retention**: Teams drops transcripts and the `onlineMeeting` object roughly
  60 days after the meeting, after which Graph returns
  `404 NotFound: 3004 Specified meeting is not found`. Past that point the index
  is the only surviving copy, so nothing may be deleted before its replacement
  is written.
- **MCP transport**: Streamable HTTP on `/mcp`
- **Data tiers**: `transcripts` (standard M365), `insights` (Copilot), or `both`

## Key Directories

- `src/` — Application source (ES modules, Node.js 20)
- `src/app.js` — Express app assembly; `src/index.js` — process startup
- `src/auth/` — OAuth routes (`/auth/login`, `/auth/callback`, `/auth/logout`) and requireAuth middleware
- `src/graph/` — Microsoft Graph API auth (MSAL ConfidentialClientApplication) and data fetching
- `src/sync/` — Sync scheduler and engine
- `src/mcp/` — MCP server and tool definitions
- `src/api/` — REST endpoints (sync, ingest, search)
- `scripts/start.sh` — Startup script (pull, Docker, MCP config)
- `scripts/migrate-session-ids.sh` — Runs the session-key migration by hand
  (it also runs automatically at startup). Dry run by default; `--apply` to
  write. Idempotent, and safe to re-run.

## Testing

- `npm test` is offline: no Docker, no credentials, no network.
- `test/integration/` talks to a real Elasticsearch and **skips itself** when
  none is configured. It exists because the query layer cannot be verified any
  other way: Elasticsearch answers a query against a nested field with zero hits
  rather than an error, so `action_items` and `meeting_notes` queries fail
  silently. Both `search_meetings` and `get_action_items` shipped broken that
  way. Any new query touching those two fields needs a test here.
- `npm run test:integration` (`scripts/test-integration.sh`) starts a throwaway
  Elasticsearch, runs the suite and removes the container, failure or Ctrl-C
  included. Set `ELASTICSEARCH_URL` to use an existing node instead and it
  manages no container — that is how CI runs it.
- Each run uses its own `meetings-itest-*` index and deletes it afterwards.
- `describe(name, { skip: null }, fn)` cancels every nested suite on Node 22.
  Pass `false`, not `null`.

## Known Limits

- **Multi-session occurrences older than Teams retention are unrecoverable and
  undetectable.** Graph cannot report that a second session ever existed, so an
  occurrence that ran twice before its transcripts expired is permanently a
  single document. An install that ran the pre-session-key schema for a while
  will carry an unknown number of these.
- **`listTranscripts` caps at `maxPages: 20` × `$top=50`** — 1000 transcripts per
  online meeting. A years-old daily series exceeds that and is truncated; the
  page walk logs a warning rather than failing silently.
- **`deduplicateMeetings` groups by `title + start_time`** and predates per-session
  documents. It is safe now only because distinct sessions have distinct actual
  start times; it would have deleted a session under the old booking-based times.
- **The `insights` data tier does not split sessions.** Graph exposes
  `aiInsights` per online meeting rather than per call, so insights attach to an
  occurrence's first session only, and an insights-only install gets one document
  per occurrence keyed on its scheduled start.

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
# ES_SECRET must be a non-empty random value before `docker compose up`, or ES
# boots with an empty password and the app can't authenticate. The start/update
# scripts generate it automatically; to do it by hand:
#   node -e "console.log('ES_SECRET='+require('crypto').randomBytes(32).toString('hex'))" >> .env
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
