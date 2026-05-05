const cookieSession = require('cookie-session');
const crypto = require('crypto');

function setupSession(app) {
  const keys = [process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex')];
  if (!process.env.SESSION_SECRET) {
    console.warn('WARNING: SESSION_SECRET not set. Using ephemeral value.');
  }
  app.use(cookieSession({
    name: 'wiw_session',
    keys,
    maxAge: 8 * 60 * 60 * 1000,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
  }));
}

module.exports = { setupSession };
