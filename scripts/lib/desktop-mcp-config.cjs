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
 * `npx` resolves `mcp-remote` against whatever npm registry is configured. When
 * Claude Desktop launches it, the working directory is Desktop's own — not this
 * repo — so the vanilla project `.npmrc` is never read and npm falls back to
 * the user's `~/.npmrc`. If that points at a private/authenticated registry
 * (e.g. AWS CodeArtifact) the fetch fails with E401 and the server never
 * starts. We pin `npm_config_userconfig` to the project `.npmrc` so npm ignores
 * `~/.npmrc` and uses the public registry regardless of cwd.
 *
 * This module is intentionally a pure data transform (no fs/process access) so
 * it can be unit-tested and reused by the startup shell script.
 */

/**
 * The stdio transport Claude Desktop understands for a remote HTTP MCP server.
 * `npmrcPath` is the absolute path to the project's vanilla `.npmrc`; it is
 * pinned as npm's user-config so npx ignores the user's `~/.npmrc`.
 */
function desiredDesktopServer(url, npmrcPath) {
  const server = { command: 'npx', args: ['-y', 'mcp-remote', url] };
  if (npmrcPath) {
    server.env = { npm_config_userconfig: npmrcPath };
  }
  return server;
}

function argsMatch(existingArgs, desiredArgs) {
  return (
    Array.isArray(existingArgs) &&
    existingArgs.length === desiredArgs.length &&
    existingArgs.every((arg, index) => arg === desiredArgs[index])
  );
}

function envMatch(existingEnv, desiredEnv) {
  if (!desiredEnv) {
    return !existingEnv || Object.keys(existingEnv).length === 0;
  }
  if (!existingEnv || typeof existingEnv !== 'object') return false;
  return existingEnv.npm_config_userconfig === desiredEnv.npm_config_userconfig;
}

/**
 * True when the existing entry is already the desired stdio form, pins the same
 * npm user-config, and carries no leftover HTTP fields (which would mean an
 * older, broken migration).
 */
function isCurrentDesktopServer(existing, desired) {
  return Boolean(
    existing &&
      existing.command === desired.command &&
      argsMatch(existing.args, desired.args) &&
      envMatch(existing.env, desired.env) &&
      !existing.type &&
      !existing.url
  );
}

/**
 * Ensure `config.mcpServers[name]` is the stdio mcp-remote form (pinned to the
 * project `.npmrc`). Returns the (mutated) config plus an action describing
 * what changed:
 *   - 'current'  : already correct, nothing to write
 *   - 'added'    : no prior entry existed
 *   - 'migrated' : an entry existed in a different shape (e.g. `type: http`,
 *                  or stdio without the npmrc pin)
 */
function applyDesktopMcpConfig(config, name, url, npmrcPath) {
  const cfg = config && typeof config === 'object' ? config : {};
  if (!cfg.mcpServers || typeof cfg.mcpServers !== 'object') {
    cfg.mcpServers = {};
  }

  const desired = desiredDesktopServer(url, npmrcPath);
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
