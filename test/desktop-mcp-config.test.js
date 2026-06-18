import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// The transform ships as CommonJS so the startup shell script can `require` it
// from an inline `node -e` invocation; import it here via createRequire.
const require = createRequire(import.meta.url);
const { applyDesktopMcpConfig, desiredDesktopServer } = require(
  '../scripts/lib/desktop-mcp-config.cjs'
);

const NAME = 'teams-insights';
const URL = 'http://localhost:4005/mcp';
const STDIO = { command: 'npx', args: ['-y', 'mcp-remote', URL] };

test('adds the stdio mcp-remote entry when none exists', () => {
  const { config, action } = applyDesktopMcpConfig({ mcpServers: {} }, NAME, URL);
  assert.equal(action, 'added');
  assert.deepEqual(config.mcpServers[NAME], STDIO);
});

test('creates mcpServers when the config object is empty', () => {
  const { config, action } = applyDesktopMcpConfig({}, NAME, URL);
  assert.equal(action, 'added');
  assert.deepEqual(config.mcpServers[NAME], STDIO);
});

test('migrates a broken native HTTP entry back to stdio (the regression)', () => {
  const broken = { mcpServers: { [NAME]: { type: 'http', url: URL } } };
  const { config, action } = applyDesktopMcpConfig(broken, NAME, URL);
  assert.equal(action, 'migrated');
  assert.deepEqual(config.mcpServers[NAME], STDIO);
  // No leftover HTTP fields that Claude Desktop would choke on.
  assert.equal(config.mcpServers[NAME].type, undefined);
  assert.equal(config.mcpServers[NAME].url, undefined);
});

test('reports current and does not mutate when already stdio', () => {
  const existing = { mcpServers: { [NAME]: { command: 'npx', args: ['-y', 'mcp-remote', URL] } } };
  const { action } = applyDesktopMcpConfig(existing, NAME, URL);
  assert.equal(action, 'current');
});

test('migrates when the URL changed even if still stdio', () => {
  const stale = { mcpServers: { [NAME]: { command: 'npx', args: ['-y', 'mcp-remote', 'http://localhost:9999/mcp'] } } };
  const { config, action } = applyDesktopMcpConfig(stale, NAME, URL);
  assert.equal(action, 'migrated');
  assert.deepEqual(config.mcpServers[NAME], STDIO);
});

test('preserves unrelated servers', () => {
  const other = { command: 'node', args: ['other.js'] };
  const cfg = { mcpServers: { 'some-other': other, [NAME]: { type: 'http', url: URL } } };
  const { config } = applyDesktopMcpConfig(cfg, NAME, URL);
  assert.deepEqual(config.mcpServers['some-other'], other);
});

test('desiredDesktopServer embeds the given url', () => {
  assert.deepEqual(desiredDesktopServer(URL), STDIO);
});
