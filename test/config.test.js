import { test } from 'node:test';
import assert from 'node:assert/strict';

// Dependency-free: buildEsClientOptions imports nothing, so this runs under
// `npm test` without installing node_modules (matching the repo's test style).
import { buildEsClientOptions } from '../src/es-client-options.js';

test('includes basic auth when a password is provided', () => {
  const opts = buildEsClientOptions({
    url: 'http://elasticsearch:9200',
    username: 'elastic',
    password: 'es-secret-value',
  });

  assert.deepEqual(opts.auth, { username: 'elastic', password: 'es-secret-value' });
  assert.equal(opts.node, 'http://elasticsearch:9200');
});

test('omits auth entirely when no password is set (unsecured local dev)', () => {
  const opts = buildEsClientOptions({
    url: 'http://localhost:9200',
    username: 'elastic',
    password: null,
  });

  assert.equal(opts.auth, undefined);
});

test('defaults the username to elastic', () => {
  const opts = buildEsClientOptions({ url: 'http://elasticsearch:9200', password: 'x' });

  assert.equal(opts.auth.username, 'elastic');
});

test('keeps credentials out of the node URL', () => {
  const opts = buildEsClientOptions({
    url: 'http://elasticsearch:9200',
    username: 'elastic',
    password: 'super-secret',
  });

  assert.ok(!opts.node.includes('super-secret'), 'password must not be embedded in the node URL');
});

test('applies its own retry budget when the caller passes none', () => {
  // config.js leaves these undefined unless the env sets them, so these are the
  // values a default install runs with. Deliberately above the client's own 3:
  // the Elasticsearch container may still be starting on the first request.
  const opts = buildEsClientOptions({ url: 'http://elasticsearch:9200' });

  assert.equal(opts.maxRetries, 5);
  assert.equal(opts.requestTimeout, 30000);
});

test('an undefined budget falls back to the default rather than reaching the client', () => {
  // config.js passes undefined for an unset variable. NaN or null here would
  // reach the client instead, and `maxRetries: NaN` makes every request resolve
  // without being sent.
  const opts = buildEsClientOptions({
    url: 'http://elasticsearch:9200',
    maxRetries: undefined,
    requestTimeout: undefined,
  });

  assert.equal(opts.maxRetries, 5);
  assert.equal(opts.requestTimeout, 30000);
});

test('honours an explicit retry budget', () => {
  // config.js exposes these as ES_MAX_RETRIES / ES_REQUEST_TIMEOUT_MS so a
  // caller that cannot afford the default backoff can shorten it.
  const opts = buildEsClientOptions({
    url: 'http://elasticsearch:9200',
    maxRetries: 0,
    requestTimeout: 1000,
  });

  assert.equal(opts.maxRetries, 0);
  assert.equal(opts.requestTimeout, 1000);
});

// ── Numeric environment variables ────────────────────────────────────
// config.js is a module singleton, so each case imports it under a fresh
// specifier to get a fresh evaluation with different environment.

process.env.SESSION_SECRET ||= 'test-session-secret';
process.env.AZURE_TENANT_ID ||= '00000000-0000-0000-0000-000000000000';
process.env.AZURE_CLIENT_ID ||= '11111111-1111-1111-1111-111111111111';
process.env.AZURE_CLIENT_SECRET ||= 'test-client-secret';

let configLoad = 0;
async function loadConfig(env) {
  const previous = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    const module = await import(`../src/config.js?case=${configLoad++}`);
    return module.default;
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('leaves an unset budget undefined so the client default applies', async () => {
  // Not 0 and not NaN: either would reach the client and override its default.
  const config = await loadConfig({ ES_MAX_RETRIES: undefined, ES_REQUEST_TIMEOUT_MS: undefined });

  assert.equal(config.elasticsearch.maxRetries, undefined);
  assert.equal(config.elasticsearch.requestTimeout, undefined);
});

test('accepts zero as a budget', async () => {
  const config = await loadConfig({ ES_MAX_RETRIES: '0' });

  assert.equal(config.elasticsearch.maxRetries, 0);
});

// A non-numeric value used to reach the Elasticsearch client as NaN, whose
// retry loop then never runs: requests resolve with undefined instead of being
// sent, so an index write reports success while writing nothing.
for (const bad of ['none', '1.5s', '1.5', '-1', 'Infinity']) {
  test(`refuses to start when ES_MAX_RETRIES is "${bad}"`, async () => {
    await assert.rejects(
      () => loadConfig({ ES_MAX_RETRIES: bad }),
      /ES_MAX_RETRIES must be a non-negative integer/,
    );
  });
}

test('validates the other numeric settings the same way', async () => {
  await assert.rejects(() => loadConfig({ PORT: 'abc' }), /PORT must be a non-negative integer/);
  await assert.rejects(
    () => loadConfig({ SYNC_LOOKBACK_DAYS: '-1' }),
    /SYNC_LOOKBACK_DAYS must be a non-negative integer/,
  );
});
