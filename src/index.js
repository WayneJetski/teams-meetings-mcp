import config from './config.js';
import { createApp } from './app.js';
import { ensureIndex } from './elasticsearch.js';
import { runPendingMigrations } from './sync/migrations.js';
import { startScheduler } from './sync/scheduler.js';
import { runSync } from './sync/engine.js';
import { isAuthenticated } from './graph/auth.js';

async function start() {
  console.log(JSON.stringify({ level: 'info', msg: 'Starting Teams Meeting Insights MCP Server' }));

  await ensureIndex();

  const app = createApp();

  app.listen(config.port, () => {
    console.log(JSON.stringify({
      level: 'info',
      msg: `Server listening on port ${config.port}`,
      mcpPath: config.mcpPath,
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
