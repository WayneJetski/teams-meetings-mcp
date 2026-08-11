import { ConfidentialClientApplication } from '@azure/msal-node';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import config from '../config.js';

const GRAPH_SCOPES = [
  'User.Read',
  'Calendars.Read',
  'OnlineMeetings.Read',
  'OnlineMeetingTranscript.Read.All',
];

const TOKEN_CACHE_PATH = join(dirname(new URL(import.meta.url).pathname), '../../.token-cache/msal-cache.json');

const cca = new ConfidentialClientApplication({
  auth: {
    clientId: config.azure.clientId,
    authority: `https://login.microsoftonline.com/${config.azure.tenantId}`,
    clientSecret: config.azure.clientSecret,
  },
});

// ── Cache persistence ────────────────────────────────────────────────

async function loadCache() {
  try {
    const data = await readFile(TOKEN_CACHE_PATH, 'utf-8');
    cca.getTokenCache().deserialize(data);
  } catch {
    // No cached tokens yet — first run
  }
}

async function saveCache() {
  const cacheDir = dirname(TOKEN_CACHE_PATH);
  await mkdir(cacheDir, { recursive: true });
  await writeFile(TOKEN_CACHE_PATH, cca.getTokenCache().serialize());
}

// ── Authenticated user state ─────────────────────────────────────────

let authenticatedUserId = null;

/** Return the Graph user ID from the OAuth login. */
export function getCurrentUserId() {
  if (authenticatedUserId) return authenticatedUserId;
  throw new Error('No Graph user ID available — sign in via the web dashboard first');
}

/**
 * Restore the authenticated user from the persisted MSAL cache.
 * Returns the Graph user ID, or null when no account is cached.
 *
 * `authenticatedUserId` is module state, so it is lost on every process start,
 * while the refresh token survives in the mounted cache volume. Without this,
 * a restarted container holds valid credentials but no user ID, and every sync
 * throws "No Graph user ID available" until someone signs in through the
 * dashboard again — silently, since the scheduler only logs the failure.
 */
export async function restoreAuthenticatedUser() {
  await loadCache();
  const accounts = await cca.getTokenCache().getAllAccounts();
  if (accounts.length === 0) return null;

  authenticatedUserId = authenticatedUserId || accounts[0].localAccountId;
  return authenticatedUserId;
}

/** True when we have a cached MSAL account we can use for silent token acquisition. */
export async function isAuthenticated() {
  return (await restoreAuthenticatedUser()) !== null;
}

// ── OAuth authorization code flow ────────────────────────────────────

const REDIRECT_PATH = '/auth/callback';

export function getRedirectUri() {
  return `${config.appBaseUrl}${REDIRECT_PATH}`;
}

/** Generate the Microsoft login URL to redirect the user to. */
export async function getAuthCodeUrl() {
  return cca.getAuthCodeUrl({
    scopes: GRAPH_SCOPES,
    redirectUri: getRedirectUri(),
    prompt: 'select_account',
  });
}

/**
 * Exchange an authorization code for tokens. Returns the MSAL
 * AuthenticationResult which includes account info and access token.
 */
export async function acquireTokenByCode(code) {
  await loadCache();

  const result = await cca.acquireTokenByCode({
    code,
    scopes: GRAPH_SCOPES,
    redirectUri: getRedirectUri(),
  });

  authenticatedUserId = result.account.localAccountId;
  await saveCache();
  return result;
}

// ── Token acquisition (silent) ───────────────────────────────────────

/**
 * Get a valid access token, refreshing silently if needed.
 * Works after the user has completed the OAuth login at least once
 * (the refresh token is persisted in the MSAL cache file).
 */
export async function getAccessToken() {
  await loadCache();

  const accounts = await cca.getTokenCache().getAllAccounts();
  if (accounts.length === 0) {
    throw new Error('No cached account — sign in via the web dashboard');
  }

  const result = await cca.acquireTokenSilent({
    account: accounts[0],
    scopes: GRAPH_SCOPES,
  });

  authenticatedUserId = result.account.localAccountId;
  await saveCache();
  return result.accessToken;
}

export { GRAPH_SCOPES };
