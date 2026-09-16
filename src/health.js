/**
 * Interpreting Elasticsearch health for the /health endpoint.
 *
 * Kept free of the ES client so the rules are testable on their own.
 */

/**
 * Index-level settings that stop writes. `read_only_allow_delete` is the one
 * Elasticsearch sets by itself when a node crosses the flood-stage disk
 * watermark; the others are set by hand. None of them affect reads or cluster
 * health, which is why a blocked index still reports green.
 */
export const WRITE_BLOCK_SETTINGS = ['read_only_allow_delete', 'read_only', 'write'];

// Elasticsearch's default disk watermarks. Crossing flood stage is what applies
// read_only_allow_delete; dropping back below high releases it automatically.
export const WATERMARK_LOW = 85;
export const WATERMARK_HIGH = 90;
export const WATERMARK_FLOOD = 95;

/**
 * Find write blocks in an indices.getSettings response.
 * Settings values come back as strings, so 'false' must not read as truthy.
 */
export function interpretBlocks(settingsResponse = {}) {
  const blocks = [];

  for (const index of Object.values(settingsResponse)) {
    const indexBlocks = index?.settings?.index?.blocks || {};
    for (const name of WRITE_BLOCK_SETTINGS) {
      if (String(indexBlocks[name]) === 'true' && !blocks.includes(name)) blocks.push(name);
    }
  }

  return { writesBlocked: blocks.length > 0, blocks };
}

/**
 * Worst disk usage across the data nodes in a cat.allocation response.
 * Rows for unassigned shards carry no disk figures and are ignored.
 */
export function summariseDisk(allocationRows = []) {
  const nodes = allocationRows
    .filter((row) => row['disk.percent'] !== undefined && row['disk.percent'] !== null && row['disk.percent'] !== '')
    .map((row) => ({
      node: row.node,
      usedPercent: Number(row['disk.percent']),
      availableBytes: Number(row['disk.avail']),
    }))
    .filter((n) => Number.isFinite(n.usedPercent));

  if (nodes.length === 0) return null;

  const worst = nodes.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a));
  return { ...worst, watermark: diskWatermark(worst.usedPercent) };
}

export function diskWatermark(usedPercent) {
  if (usedPercent >= WATERMARK_FLOOD) return 'flood';
  if (usedPercent >= WATERMARK_HIGH) return 'high';
  if (usedPercent >= WATERMARK_LOW) return 'low';
  return 'ok';
}

/**
 * Overall service status.
 *
 * A blocked index is reported as degraded rather than unhealthy, and over HTTP
 * 200: search, the MCP tools and the dashboard all still work, only ingest is
 * impaired. Failing the endpoint outright would tell every consumer the server
 * is down, which is both false and less actionable.
 */
export function overallStatus({ writesBlocked, disk }) {
  if (writesBlocked) return 'degraded';
  if (disk && disk.watermark !== 'ok') return 'degraded';
  return 'ok';
}
