/**
 * Build the options object for the @elastic/elasticsearch Client.
 *
 * Auth is included only when a password is provided, so local development
 * against an unsecured Elasticsearch still works. Credentials are passed via
 * the `auth` option rather than embedded in the node URL, which can be logged.
 *
 * Kept dependency-free (no config/client imports) so it is trivially testable.
 *
 * @param {object} params
 * @param {string} params.url - Elasticsearch node URL.
 * @param {string} [params.username] - Username for basic auth.
 * @param {string|null} [params.password] - Password; when falsy, auth is omitted.
 * @param {number} [params.maxRetries]
 * @param {number} [params.requestTimeout]
 * @returns {object} Options for `new Client(...)`.
 */
export function buildEsClientOptions({
  url,
  username = 'elastic',
  password = null,
  maxRetries = 5,
  requestTimeout = 30000,
}) {
  const options = { node: url, maxRetries, requestTimeout };
  if (password) {
    options.auth = { username, password };
  }
  return options;
}
