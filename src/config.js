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
