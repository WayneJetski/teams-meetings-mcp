import cron from 'node-cron';
import config from '../config.js';
import { runSync } from './engine.js';
import { isAuthenticated } from '../graph/auth.js';

let task = null;

export function startScheduler() {
  const cronExpr = config.sync.cron;

  if (!cron.validate(cronExpr)) {
    console.log(JSON.stringify({ level: 'error', msg: `Invalid cron expression: ${cronExpr}` }));
    return;
  }

  task = cron.schedule(cronExpr, async () => {
    const hasAuth = await isAuthenticated();
    if (!hasAuth) {
      console.log(JSON.stringify({ level: 'info', msg: 'Scheduled sync skipped — no authenticated user yet' }));
      return;
    }

    console.log(JSON.stringify({ level: 'info', msg: 'Scheduled sync triggered' }));
    try {
      await runSync();
    } catch (err) {
      console.log(JSON.stringify({ level: 'error', msg: 'Scheduled sync failed', error: err.message }));
    }
  });

  console.log(JSON.stringify({ level: 'info', msg: `Sync scheduler started`, cron: cronExpr }));
}

export function stopScheduler() {
  if (task) {
    task.stop();
    task = null;
  }
}
