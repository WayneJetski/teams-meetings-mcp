import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import express from 'express';
import session from 'express-session';
import config from './config.js';
import { ensureIndex, healthCheck } from './elasticsearch.js';
import { runPendingMigrations } from './sync/migrations.js';
import { handleStreamableHttp } from './mcp/server.js';
import { startScheduler } from './sync/scheduler.js';
import { runSync } from './sync/engine.js';
import { isAuthenticated } from './graph/auth.js';
import authRouter from './auth/routes.js';
import { requireAuth } from './auth/requireAuth.js';
import apiRouter from './api/router.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();

// ── Session middleware ────────────────────────────────────────────────

app.use(session({
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: config.nodeEnv === 'production' && config.appBaseUrl.startsWith('https'),
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
  },
}));

// Parse JSON for all routes except the MCP endpoint (which handles its own parsing)
app.use((req, res, next) => {
  if (req.path === config.mcpPath) return next();
  express.json({ limit: '10mb' })(req, res, next);
});

// ── Public routes (no auth required) ─────────────────────────────────

// Health check — always public for monitoring
app.get('/health', async (req, res) => {
  try {
    const { serviceStatus, ...es } = await healthCheck();
    // Degraded stays a 200: search, the MCP tools and the dashboard all keep
    // working when only writes are blocked, and a non-2xx would report the
    // whole server as down.
    res.json({ status: serviceStatus, elasticsearch: es, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: 'unhealthy', error: err.message, timestamp: new Date().toISOString() });
  }
});

// Favicon — public so it renders on the pre-login page too
app.get('/favicon.svg', (req, res) => res.sendFile(join(__dirname, 'public', 'favicon.svg')));

// Auth routes (login, callback, logout, me)
app.use(authRouter);

// Return JSON 404 for OAuth discovery endpoints so the MCP SDK
// knows this server does not require MCP-level authentication.
app.all('/.well-known/oauth-protected-resource', (req, res) => res.status(404).json({ error: 'not_found' }));
app.all('/.well-known/oauth-authorization-server', (req, res) => res.status(404).json({ error: 'not_found' }));
app.post('/register', (req, res) => res.status(404).json({ error: 'not_found' }));

// MCP endpoint — left open for the local Claude client
const mcpPath = config.mcpPath;
const mcp = handleStreamableHttp(mcpPath);
app.all(mcpPath, (req, res) => mcp.handleRequest(req, res));

// ── Protected routes (auth required) ─────────────────────────────────

app.use(requireAuth);

// REST API routes
app.use('/', apiRouter);

// Static dashboard
app.use(express.static(join(__dirname, 'public')));

// ── Start ────────────────────────────────────────────────────────────

async function start() {
  console.log(JSON.stringify({ level: 'info', msg: 'Starting Teams Meeting Insights MCP Server' }));

  await ensureIndex();

  app.listen(config.port, () => {
    console.log(JSON.stringify({
      level: 'info',
      msg: `Server listening on port ${config.port}`,
      mcpPath,
      dataTier: config.graph.dataTier,
    }));
  });

  // Before any sync: a pending migration and a sync both write meeting
  // documents, and the migration deletes the keys the old data sits under.
  // Listening starts first so the dashboard is reachable for sign-in even while
  // this runs.
  await runPendingMigrations();

  // Start the sync scheduler (runs only when a cached token is available)
  startScheduler();

  // Run initial sync only if we already have cached auth (returning user)
  if (await isAuthenticated()) {
    console.log(JSON.stringify({ level: 'info', msg: 'Cached auth found — running initial sync' }));
    try {
      await runSync();
    } catch (err) {
      console.log(JSON.stringify({ level: 'error', msg: 'Initial sync failed (will retry on schedule)', error: err.message }));
    }
  } else {
    console.log(JSON.stringify({ level: 'info', msg: 'No cached auth — sync will run after first login' }));
  }
}

start().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
