/**
 * Express middleware that requires an authenticated session.
 * Browser requests are redirected to the login page.
 * API/XHR requests receive a 401 JSON response.
 */
export function requireAuth(req, res, next) {
  if (req.session?.user) return next();

  const isApiRequest =
    req.xhr ||
    (req.headers.accept && req.headers.accept.includes('application/json')) ||
    req.path.startsWith('/api/') ||
    req.path.startsWith('/sync') ||
    req.path.startsWith('/ingest');

  if (isApiRequest) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  // Remember where the user was trying to go so we can redirect after login
  req.session.returnTo = req.originalUrl;
  res.redirect('/auth/login');
}
