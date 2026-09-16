import 'dotenv/config';

const required = (name) => {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
};

const optional = (name, fallback) => process.env[name] || fallback;

const config = {
  port: parseInt(optional('PORT', '4005'), 10),
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
    // Retry/timeout budget for the ES client. Defaults match the client's own
    // and suit a container that may still be starting; tests lower them so an
    // unreachable ES fails in milliseconds instead of retrying for ~14s.
    maxRetries: parseInt(optional('ES_MAX_RETRIES', '5'), 10),
    requestTimeout: parseInt(optional('ES_REQUEST_TIMEOUT_MS', '30000'), 10),
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
    lookbackDays: parseInt(optional('SYNC_LOOKBACK_DAYS', '30'), 10),
  },
};

export default config;
