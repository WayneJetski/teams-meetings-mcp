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
