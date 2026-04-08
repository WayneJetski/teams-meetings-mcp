import { getAccessToken } from './auth.js';

const GRAPH_BASE = 'https://graph.microsoft.com';

async function graphFetch(url, options = {}) {
  const token = await getAccessToken();
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...options.headers,
  };

  const res = await fetch(url, { ...options, headers });

  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get('Retry-After') || '10', 10);
    console.log(JSON.stringify({ level: 'warn', msg: `Rate limited, retrying after ${retryAfter}s` }));
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    return graphFetch(url, options);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Graph API ${res.status}: ${body}`);
  }

  return res;
}

export async function graphGet(path, params = {}) {
  const url = new URL(path, GRAPH_BASE);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  const res = await graphFetch(url.toString());
  return res.json();
}

export async function graphGetText(path, accept = 'text/vtt') {
  const url = new URL(path, GRAPH_BASE);
  const res = await graphFetch(url.toString(), {
    headers: { Accept: accept },
  });
  return res.text();
}
