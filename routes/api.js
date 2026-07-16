const express = require('express');
const router = express.Router();
const db = require('../db/dynamo');
const imapSync = require('../lib/imap-sync');
const { today: todayLocal } = require('../lib/dates');

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Token-protected inbox sync, for an optional scheduled trigger (e.g. EventBridge
// Scheduler hitting this URL on a cron). No-op unless MAIL_CRON_KEY is set and
// matches the provided ?key=. The in-app "Refresh" button is the primary path;
// this exists so inbound mail can be pulled while no admin is looking.
router.get('/cron/sync-inbox', asyncHandler(async (req, res) => {
  const expected = process.env.MAIL_CRON_KEY;
  if (!expected || req.query.key !== expected) {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }
  const result = await imapSync.syncAllMailboxes();
  res.json({ ok: true, ...result });
}));

// Get available dates for a program (used by calendar component)
router.get('/dates/:programId', asyncHandler(async (req, res) => {
  const programId = req.params.programId;
  const dates = await db.getDatesByProgram(programId);

  // Never offer dates that have already passed (Pacific time).
  const today = todayLocal();
  const upcoming = dates.filter(d => d.date >= today);

  res.json(upcoming.map(d => ({
    date: d.date,
    capacity: d.maxCapacity,
    enrolled: d.enrolled || 0,
    available: d.maxCapacity - (d.enrolled || 0),
  })));
}));

module.exports = router;
