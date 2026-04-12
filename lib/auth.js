/**
 * Admin authentication helpers.
 * Credentials are read from ADMIN_USER and ADMIN_PASS environment variables.
 */

function validateAdmin(username, pw) {
  const expectedUser = process.env.ADMIN_USER;
  const expectedPw = process.env.ADMIN_PASS;
  if (!expectedUser || !expectedPw) {
    return { ok: false, reason: 'Admin credentials not configured. Set ADMIN_USER and ADMIN_PASS env vars.' };
  }
  if (username === expectedUser && pw === expectedPw) {
    return { ok: true };
  }
  return { ok: false, reason: 'Invalid credentials.' };
}

function requireAuth(req, res, next) {
  if (req.session.isAdmin) return next();
  res.redirect('/admin/login');
}

module.exports = { validateAdmin, requireAuth };
