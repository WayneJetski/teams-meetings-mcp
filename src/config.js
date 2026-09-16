import 'dotenv/config';

const required = (name) => {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
};

const optional = (name, fallback) => process.env[name] || fallback;

/**
 * A numeric setting, validated at startup.
 *
 * A bad value has to fail here, because it is silently destructive downstream:
 * the Elasticsearch client accepts `maxRetries: NaN` (NaN is a number) and its
 * retry loop, `while (attempts <= maxRetries)`, then never runs — every request
 * resolves with `undefined` instead of throwing, so a write would report
 * success without writing.
 *
 * `Number` rather than `parseInt`, which reads a leading prefix and discards
 * the rest: `parseInt('1.5s')` is 1, turning a typo into a 1ms timeout.
 *
 * `fallback` is returned unparsed when the variable is unset, so passing
 * `undefined` means "leave it to the consumer's own default" rather than
 * restating that default here.
 */
const optionalInt = (name, fallback) => {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Environment variable ${name} must be a non-negative integer (got: "${raw}")`);
  }
  return parsed;
};

const config = {
  port: optionalInt('PORT', 4005),
  nodeEnv: optional('NODE_ENV', 'development'),
  mcpPath: optional('MCP_PATH', '/mcp'),
  appBaseUrl: optional('APP_BASE_URL', `http://localhost:${optional('PORT', '4005')}`),
  sessionSecret: required('SESSION_SECRET'),

  elasticsearch: {
    url: optional('ELASTICSEARCH_URL', 'http://localhost:9200'),
    index: optional('ES_INDEX', 'meetings'),
    username: optional('ELASTICSEARCH_USERNAME', 'elastic'),
    // Nullable so local, non-Docker dev against an unsecured ES still works.
    // Docker always supplies this (mapped from ES_SECRET in docker-compose.yml).
    password: process.env.ELASTICSEARCH_PASSWORD || null,
    // Retry/timeout budget for the ES client, exposed so a caller that cannot
    // afford the default backoff can shorten it — the route tests lower it so an
    // unreachable ES fails in milliseconds rather than retrying for seconds.
    // Left undefined when unset so buildEsClientOptions' defaults still apply:
    // an install that sets neither behaves exactly as it did before these
    // became configurable. Note those are the repo's defaults (5 retries),
    // deliberately above the client's own 3, because the Elasticsearch
    // container may still be starting when the first request goes out.
    maxRetries: optionalInt('ES_MAX_RETRIES', undefined),
    requestTimeout: optionalInt('ES_REQUEST_TIMEOUT_MS', undefined),
  },

  azure: {
    tenantId: required('AZURE_TENANT_ID'),
    clientId: required('AZURE_CLIENT_ID'),
    clientSecret: required('AZURE_CLIENT_SECRET'),
  },

  graph: {
    dataTier: optional('GRAPH_DATA_TIER', 'transcripts'),
  },

  sync: {
    cron: optional('SYNC_CRON', '0 * * * *'),
    lookbackDays: optionalInt('SYNC_LOOKBACK_DAYS', 30),
  },
};

export default config;
