import { migrateSessionIds } from '../sync/migrateSessionIds.js';

const apply = process.argv.includes('--apply');

const { summary, actions } = await migrateSessionIds({ apply });

for (const a of actions) {
  const arrow = a.to.length > 1 ? `-> ${a.to.length} sessions` : '->';
  console.log(`${a.action.padEnd(8)} ${a.scheduled?.slice(0, 16)}  ${a.title}`);
  console.log(`         ${a.from}`);
  for (const to of a.to) console.log(`  ${arrow} ${to}`);
}

console.log('');
console.log(JSON.stringify(summary, null, 2));
if (!apply) console.log('\nDry run. Re-run with --apply to write.');

process.exit(summary.complete ? 0 : 1);
