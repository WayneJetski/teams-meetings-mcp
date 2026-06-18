'use strict';

/**
 * Claude Desktop MCP config transform.
 *
 * Claude Desktop's `claude_desktop_config.json` only reliably supports stdio
 * servers (`command` + `args`). It does NOT understand the native
 * `{ type: 'http', url }` shape that Claude Code's `~/.claude.json` accepts, so
 * an HTTP entry there silently fails to load. For Desktop we therefore wrap the
 * server in `npx mcp-remote <url>`, which bridges the local HTTP endpoint over
 * stdio.
 *
 * This module is intentionally a pure data transform (no fs/process access) so
 * it can be unit-tested and reused by the startup shell script.
 */

/** The stdio transport Claude Desktop understands for a remote HTTP MCP server. */
function desiredDesktopServer(url) {
  return { command: 'npx', args: ['-y', 'mcp-remote', url] };
}

function argsMatch(existingArgs, desiredArgs) {
  return (
    Array.isArray(existingArgs) &&
    existingArgs.length === desiredArgs.length &&
    existingArgs.every((arg, index) => arg === desiredArgs[index])
  );
}

/**
 * True when the existing entry is already the desired stdio form and carries no
 * leftover HTTP fields (which would mean an older, broken migration).
 */
function isCurrentDesktopServer(existing, desired) {
  return Boolean(
    existing &&
      existing.command === desired.command &&
      argsMatch(existing.args, desired.args) &&
      !existing.type &&
      !existing.url
  );
}

/**
 * Ensure `config.mcpServers[name]` is the stdio mcp-remote form. Returns the
 * (mutated) config plus an action describing what changed:
 *   - 'current'  : already correct, nothing to write
 *   - 'added'    : no prior entry existed
 *   - 'migrated' : an entry existed in a different shape (e.g. `type: http`)
 */
function applyDesktopMcpConfig(config, name, url) {
  const cfg = config && typeof config === 'object' ? config : {};
  if (!cfg.mcpServers || typeof cfg.mcpServers !== 'object') {
    cfg.mcpServers = {};
  }

  const desired = desiredDesktopServer(url);
  const existing = cfg.mcpServers[name];

  if (isCurrentDesktopServer(existing, desired)) {
    return { config: cfg, action: 'current' };
  }

  cfg.mcpServers[name] = desired;
  return { config: cfg, action: existing ? 'migrated' : 'added' };
}

module.exports = {
  applyDesktopMcpConfig,
  desiredDesktopServer,
  isCurrentDesktopServer,
};
