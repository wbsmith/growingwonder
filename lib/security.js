const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

// Helmet defaults are strict; relax CSP just enough for our embedded fonts,
// inline styles in EJS templates, and the Quill CDN used in the admin editor.
const helmetMiddleware = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdn.jsdelivr.net'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'https://wiw-media-assets.s3.us-west-1.amazonaws.com'],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
});

const publicFormLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many submissions. Please try again later.' },
});

// Session-backed CSRF: token issued on first request, required on state-changing
// requests as either form field _csrf or header x-csrf-token. Login is exempted
// because the session (and thus the token) only exists post-login; the login
// endpoint is protected by loginLimiter instead.
function csrfMiddleware(req, res, next) {
  if (!req.session) return next();
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  res.locals.csrfToken = req.session.csrfToken;

  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return next();
  }
  if (req.path === '/login') return next();

  const submitted = (req.body && req.body._csrf) || req.headers['x-csrf-token'];
  if (submitted && submitted === req.session.csrfToken) {
    return next();
  }
  res.status(403).send('Invalid or missing CSRF token. Reload the page and try again.');
}

module.exports = { helmetMiddleware, loginLimiter, publicFormLimiter, csrfMiddleware };
