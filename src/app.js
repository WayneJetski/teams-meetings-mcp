import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import express from 'express';
import session from 'express-session';
import config from './config.js';
import { healthCheck } from './elasticsearch.js';
import { handleStreamableHttp } from './mcp/server.js';
import authRouter from './auth/routes.js';
import { requireAuth } from './auth/requireAuth.js';
import apiRouter from './api/router.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Assemble the Express application.
 *
 * Kept separate from `index.js` so that building the app carries no process
 * side effects: no listener, no migrations, no scheduler, no initial sync.
 * Route-protection tests depend on that separation — importing the module used
 * to start the whole server.
 *
 * Middleware order is the security boundary here. Everything registered before
 * `requireAuth` is public; everything after it needs a session. Moving a route
 * across that line silently changes who can reach it, which is what
 * `test/routes.test.js` pins down.
 *
 * @returns {import('express').Express}
 */
export function createApp() {
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
  const mcp = handleStreamableHttp(config.mcpPath);
  app.all(config.mcpPath, (req, res) => mcp.handleRequest(req, res));

  // ── Protected routes (auth required) ─────────────────────────────────

  app.use(requireAuth);

  // REST API routes
  app.use('/', apiRouter);

  // Static dashboard
  app.use(express.static(join(__dirname, 'public')));

  return app;
}
