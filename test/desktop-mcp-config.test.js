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
const NPMRC = '/Users/example/dev/teams-meetings-mcp/.npmrc';
const STDIO = {
  command: 'npx',
  args: ['-y', 'mcp-remote', URL],
  env: { npm_config_userconfig: NPMRC },
};

test('adds the stdio mcp-remote entry pinned to the project .npmrc', () => {
  const { config, action } = applyDesktopMcpConfig({ mcpServers: {} }, NAME, URL, NPMRC);
  assert.equal(action, 'added');
  assert.deepEqual(config.mcpServers[NAME], STDIO);
});

test('creates mcpServers when the config object is empty', () => {
  const { config, action } = applyDesktopMcpConfig({}, NAME, URL, NPMRC);
  assert.equal(action, 'added');
  assert.deepEqual(config.mcpServers[NAME], STDIO);
});

test('migrates a broken native HTTP entry back to stdio (the regression)', () => {
  const broken = { mcpServers: { [NAME]: { type: 'http', url: URL } } };
  const { config, action } = applyDesktopMcpConfig(broken, NAME, URL, NPMRC);
  assert.equal(action, 'migrated');
  assert.deepEqual(config.mcpServers[NAME], STDIO);
  // No leftover HTTP fields that Claude Desktop would choke on.
  assert.equal(config.mcpServers[NAME].type, undefined);
  assert.equal(config.mcpServers[NAME].url, undefined);
});

test('migrates a stdio entry that lacks the npmrc pin (the E401 fix)', () => {
  const unpinned = { mcpServers: { [NAME]: { command: 'npx', args: ['-y', 'mcp-remote', URL] } } };
  const { config, action } = applyDesktopMcpConfig(unpinned, NAME, URL, NPMRC);
  assert.equal(action, 'migrated');
  assert.deepEqual(config.mcpServers[NAME].env, { npm_config_userconfig: NPMRC });
});

test('reports current and does not mutate when already pinned stdio', () => {
  const existing = { mcpServers: { [NAME]: { ...STDIO } } };
  const { action } = applyDesktopMcpConfig(existing, NAME, URL, NPMRC);
  assert.equal(action, 'current');
});

test('migrates when the pinned npmrc path changed', () => {
  const stalePin = {
    mcpServers: { [NAME]: { command: 'npx', args: ['-y', 'mcp-remote', URL], env: { npm_config_userconfig: '/old/path/.npmrc' } } },
  };
  const { config, action } = applyDesktopMcpConfig(stalePin, NAME, URL, NPMRC);
  assert.equal(action, 'migrated');
  assert.equal(config.mcpServers[NAME].env.npm_config_userconfig, NPMRC);
});

test('migrates when the URL changed even if still stdio', () => {
  const stale = { mcpServers: { [NAME]: { command: 'npx', args: ['-y', 'mcp-remote', 'http://localhost:9999/mcp'], env: { npm_config_userconfig: NPMRC } } } };
  const { config, action } = applyDesktopMcpConfig(stale, NAME, URL, NPMRC);
  assert.equal(action, 'migrated');
  assert.deepEqual(config.mcpServers[NAME], STDIO);
});

test('preserves unrelated servers', () => {
  const other = { command: 'node', args: ['other.js'] };
  const cfg = { mcpServers: { 'some-other': other, [NAME]: { type: 'http', url: URL } } };
  const { config } = applyDesktopMcpConfig(cfg, NAME, URL, NPMRC);
  assert.deepEqual(config.mcpServers['some-other'], other);
});

test('omits the env block when no npmrc path is given', () => {
  const { config } = applyDesktopMcpConfig({ mcpServers: {} }, NAME, URL);
  assert.equal(config.mcpServers[NAME].env, undefined);
  assert.deepEqual(desiredDesktopServer(URL), { command: 'npx', args: ['-y', 'mcp-remote', URL] });
});

test('desiredDesktopServer embeds the url and npmrc pin', () => {
  assert.deepEqual(desiredDesktopServer(URL, NPMRC), STDIO);
});
