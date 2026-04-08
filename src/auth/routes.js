import { Router } from 'express';
import { getAuthCodeUrl, acquireTokenByCode } from '../graph/auth.js';
import { runSync } from '../sync/engine.js';

const router = Router();

/** Redirect the user to the Microsoft login page. */
router.get('/auth/login', async (req, res) => {
  try {
    const url = await getAuthCodeUrl();
    res.redirect(url);
  } catch (err) {
    console.log(JSON.stringify({ level: 'error', msg: 'Failed to generate auth URL', error: err.message }));
    res.status(500).send('Authentication unavailable — check server logs.');
  }
});

/** Microsoft redirects back here with an authorization code. */
router.get('/auth/callback', async (req, res) => {
  const { code, error, error_description: errorDescription } = req.query;

  if (error) {
    console.log(JSON.stringify({ level: 'error', msg: 'OAuth error', error, errorDescription }));
    return res.status(400).send(`Authentication failed: ${errorDescription || error}`);
  }

  if (!code) {
    return res.status(400).send('Missing authorization code.');
  }

  try {
    const result = await acquireTokenByCode(code);

    req.session.user = {
      id: result.account.localAccountId,
      name: result.account.name || result.account.username,
      email: result.account.username,
    };

    const returnTo = req.session.returnTo || '/';
    delete req.session.returnTo;
    res.redirect(returnTo);

    // Kick off initial sync in the background now that we have auth tokens
    runSync().catch((err) => {
      console.log(JSON.stringify({ level: 'error', msg: 'Post-login sync failed', error: err.message }));
    });
  } catch (err) {
    console.log(JSON.stringify({ level: 'error', msg: 'Token exchange failed', error: err.message }));
    res.status(500).send('Authentication failed — could not exchange code for token.');
  }
});

/** Destroy the session and redirect to the landing page. */
router.post('/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/auth/login');
  });
});

/** Return the current user (for the dashboard UI). */
router.get('/auth/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  res.json(req.session.user);
});

export default router;
