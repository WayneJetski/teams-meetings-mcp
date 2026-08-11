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

/**
 * GET a collection, following @odata.nextLink.
 *
 * Graph caps page size well below what a 30-day window can contain, so a
 * single unpaged request silently truncates: the oldest items in the range
 * just never appear. `maxPages` bounds the walk, and `shouldContinue` lets a
 * caller stop early once it has paged far enough back to cover its window.
 *
 * `path` may be absolute (a nextLink), which `new URL(path, base)` honours.
 */
export async function graphGetAll(path, params = {}, { maxPages = 20, shouldContinue } = {}) {
  const items = [];
  let page = await graphGet(path, params);
  items.push(...(page.value || []));
  let nextLink = page['@odata.nextLink'];
  let pagesFetched = 1;

  while (nextLink && pagesFetched < maxPages) {
    if (shouldContinue && !shouldContinue(items)) return items;
    page = await graphGet(nextLink);
    items.push(...(page.value || []));
    nextLink = page['@odata.nextLink'];
    pagesFetched++;
  }

  if (nextLink) {
    console.log(JSON.stringify({
      level: 'warn',
      msg: 'Graph pagination stopped at maxPages — results may be truncated',
      maxPages,
      itemsFetched: items.length,
    }));
  }

  return items;
}

export async function graphGetText(path, accept = 'text/vtt') {
  const url = new URL(path, GRAPH_BASE);
  const res = await graphFetch(url.toString(), {
    headers: { Accept: accept },
  });
  return res.text();
}
