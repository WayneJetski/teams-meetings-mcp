import { test } from 'node:test';
import assert from 'node:assert/strict';

// Dependency-free: health.js imports nothing, so this runs under `npm test`
// without installing node_modules (matching the repo's test style).
import {
  interpretBlocks,
  summariseDisk,
  diskWatermark,
  overallStatus,
  WATERMARK_FLOOD,
} from '../src/health.js';

const settings = (blocks) => ({ meetings: { settings: { index: { blocks } } } });

// ── write blocks ─────────────────────────────────────────────────────

test('an unblocked index reports no blocks', () => {
  assert.deepEqual(interpretBlocks({}), { writesBlocked: false, blocks: [] });
  assert.deepEqual(interpretBlocks(settings({})), { writesBlocked: false, blocks: [] });
});

test('the flood-stage block Elasticsearch applies itself is detected', () => {
  const result = interpretBlocks(settings({ read_only_allow_delete: 'true' }));

  assert.equal(result.writesBlocked, true);
  assert.deepEqual(result.blocks, ['read_only_allow_delete']);
});

test('settings values are strings, so a false block does not read as truthy', () => {
  const result = interpretBlocks(settings({ read_only_allow_delete: 'false', write: 'false' }));

  assert.equal(result.writesBlocked, false, "'false' is a non-empty string and would otherwise pass a truthiness check");
});

test('hand-applied blocks are reported too, without duplicates', () => {
  const result = interpretBlocks({
    meetings: { settings: { index: { blocks: { read_only: 'true', write: 'true' } } } },
    other: { settings: { index: { blocks: { read_only: 'true' } } } },
  });

  assert.deepEqual(result.blocks, ['read_only', 'write']);
});

// ── disk ─────────────────────────────────────────────────────────────

test('the worst data node decides the reported disk usage', () => {
  const disk = summariseDisk([
    { node: 'a', 'disk.percent': '40', 'disk.avail': '100' },
    { node: 'b', 'disk.percent': '91', 'disk.avail': '10' },
  ]);

  assert.equal(disk.node, 'b');
  assert.equal(disk.usedPercent, 91);
  assert.equal(disk.watermark, 'high');
});

test('unassigned-shard rows carry no disk figures and are ignored', () => {
  const disk = summariseDisk([
    { node: 'a', 'disk.percent': '40', 'disk.avail': '100' },
    { shards: '3', node: 'UNASSIGNED' },
  ]);

  assert.equal(disk.node, 'a');
});

test('no usable rows reports nothing rather than guessing', () => {
  assert.equal(summariseDisk([]), null);
  assert.equal(summariseDisk([{ node: 'UNASSIGNED' }]), null);
});

test('watermarks match the defaults Elasticsearch enforces', () => {
  assert.equal(diskWatermark(50), 'ok');
  assert.equal(diskWatermark(85), 'low');
  assert.equal(diskWatermark(90), 'high');
  assert.equal(diskWatermark(WATERMARK_FLOOD), 'flood');
});

// ── overall status ───────────────────────────────────────────────────

test('a blocked index is degraded, not healthy', () => {
  assert.equal(overallStatus({ writesBlocked: true, disk: null }), 'degraded');
});

test('disk over a watermark is degraded before writes are blocked', () => {
  assert.equal(
    overallStatus({ writesBlocked: false, disk: { usedPercent: 91, watermark: 'high' } }),
    'degraded',
    'the point is to warn before the flood-stage block lands',
  );
});

test('healthy stays healthy', () => {
  assert.equal(overallStatus({ writesBlocked: false, disk: { usedPercent: 40, watermark: 'ok' } }), 'ok');
  assert.equal(overallStatus({ writesBlocked: false, disk: null }), 'ok');
});
