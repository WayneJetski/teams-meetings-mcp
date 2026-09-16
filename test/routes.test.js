import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';

// config.js reads these at import time and throws without them. These run
// before the dynamic import below, and dotenv does not overwrite an entry that
// is already set, so these placeholders take precedence over a developer's
// .env — which is what keeps the run hermetic. Only the surrounding shell can
// override them. Do not move them after the import.
process.env.SESSION_SECRET ||= 'test-session-secret';
process.env.AZURE_TENANT_ID ||= '00000000-0000-0000-0000-000000000000';
process.env.AZURE_CLIENT_ID ||= '11111111-1111-1111-1111-111111111111';
process.env.AZURE_CLIENT_SECRET ||= 'test-client-secret';

// These tests never assert on Elasticsearch data, but /health does call it.
// Without a budget this small, an unreachable ES makes that one test retry for
// roughly 14 seconds.
process.env.ES_MAX_RETRIES ||= '0';
process.env.ES_REQUEST_TIMEOUT_MS ||= '1000';

let server;
let baseUrl;

/** Request a path without following redirects, so 302s stay observable. */
function request(path, { method = 'GET', accept = 'text/html' } = {}) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { accept },
    redirect: 'manual',
  });
}

before(async () => {
  // Dynamic so the env above is in place first.
  const { createApp } = await import('../src/app.js');
  server = createApp().listen(0);
  // Settle on 'error' too: node:test applies no timeout by default, so a
  // listener that never comes up would otherwise hang the run instead of
  // failing it.
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

// Tolerate a failed `before`: without the guard this throws on an undefined
// server and buries the real cause.
after(() => (server ? new Promise((resolve) => server.close(resolve)) : undefined));

// Every route below is requested with no session cookie. That is the whole
// point: these assert what an unauthenticated caller can reach.

describe('public routes', () => {
  // /health has to answer monitoring probes before anyone signs in. It talks to
  // Elasticsearch, so the status depends on whether ES is up (200 when
  // reachable, 503 when not) — what matters here is that auth never gates it.
  test('/health is not gated by auth', async () => {
    const res = await request('/health');
    assert.ok([200, 503].includes(res.status), `expected 200 or 503, got ${res.status}`);
    const body = await res.json();
    assert.ok(body.status, 'health response carries a status');
  });

  test('the MCP endpoint is reachable without a session', async () => {
    // A GET with no mcp-session-id is rejected by the transport itself with a
    // 400. Reaching that check at all proves requireAuth did not intercept.
    const res = await request('/mcp', { accept: 'application/json' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /session ID/i);
  });

  test('OAuth discovery endpoints 404 as JSON', async () => {
    // The MCP SDK reads a JSON 404 here as "this server needs no MCP-level
    // auth". An HTML login redirect instead would make it try to authenticate.
    for (const path of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-authorization-server',
    ]) {
      const res = await request(path, { accept: 'application/json' });
      assert.equal(res.status, 404, `${path} status`);
      assert.deepEqual(await res.json(), { error: 'not_found' }, `${path} body`);
    }
  });

  test('POST /register 404s as JSON', async () => {
    // Same contract as the two endpoints above, and the only one of the three
    // registered with `app.post` rather than `app.all`, so the likeliest to
    // drift across the requireAuth line unnoticed.
    const res = await request('/register', { method: 'POST', accept: 'application/json' });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'not_found' });
  });

  test('/auth/me reports no session rather than redirecting', async () => {
    const res = await request('/auth/me', { accept: 'application/json' });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'Not authenticated' });
  });
});

describe('protected API routes reject unauthenticated callers', () => {
  const apiRoutes = [
    ['POST', '/sync'],
    ['GET', '/sync/status'],
    ['POST', '/ingest'],
    ['GET', '/api/meetings'],
    ['GET', '/api/meetings/some-meeting-id'],
    ['GET', '/api/search?q=anything'],
    ['GET', '/api/stats'],
    ['POST', '/api/deduplicate'],
  ];

  for (const [method, path] of apiRoutes) {
    test(`${method} ${path} → 401 JSON`, async () => {
      const res = await request(path, { method, accept: 'application/json' });
      assert.equal(res.status, 401, `${method} ${path} should not be reachable`);
      assert.deepEqual(await res.json(), { error: 'Authentication required' });
    });
  }
});

describe('protected browser routes redirect to login', () => {
  // The dashboard is static files served after requireAuth. Serving it to an
  // anonymous visitor would expose the UI shell, so it must redirect too.
  for (const path of ['/', '/index.html', '/some/unknown/page']) {
    test(`GET ${path} → 302 /auth/login`, async () => {
      const res = await request(path);
      assert.equal(res.status, 302, `${path} status`);
      assert.equal(res.headers.get('location'), '/auth/login', `${path} location`);
    });
  }

  test('a JSON client gets 401 instead of a redirect', async () => {
    // Same path, different Accept header: XHR callers need a status they can
    // branch on, not an opaque redirect to an HTML login page.
    const res = await request('/', { accept: 'application/json' });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'Authentication required' });
  });
});
