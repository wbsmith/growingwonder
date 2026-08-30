const express = require('express');
const https = require('https');
const crypto = require('crypto');
const router = express.Router();
const db = require('../db/dynamo');
const imapSync = require('../lib/imap-sync');
const { today: todayLocal } = require('../lib/dates');

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---- SES delivery events (SES config set -> SNS -> here) ----
//
// SNS delivers bounce/complaint/delivery notifications as a POST with a
// text/plain body (so the global express.json() misses it — we mount
// express.text() on THIS route only). We authenticate in two independent layers:
// a shared-secret ?key (like the cron route) AND a real SNS signature check
// (SigningCertURL + crypto), so a leaked key alone can't spoof delivery events.

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

// Only ever fetch (cert / SubscribeURL) from a genuine AWS SNS host over HTTPS —
// SigningCertURL/SubscribeURL come from the request body, so this is the SSRF guard.
function isAwsSnsUrl(url, requirePem) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    if (!/^sns\.[a-z0-9-]+\.amazonaws\.com$/.test(u.hostname)) return false;
    if (requirePem && !u.pathname.endsWith('.pem')) return false;
    return true;
  } catch { return false; }
}

// Fields (in this exact order) that SNS signs, per message Type.
const SNS_SIGN_KEYS = {
  Notification: ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'],
  SubscriptionConfirmation: ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'],
  UnsubscribeConfirmation: ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'],
};

function snsCanonicalString(msg) {
  const keys = SNS_SIGN_KEYS[msg.Type];
  if (!keys) return null;
  let out = '';
  for (const k of keys) {
    if (msg[k] === undefined || msg[k] === null) continue; // Subject is optional
    out += k + '\n' + msg[k] + '\n';
  }
  return out;
}

const _certCache = new Map(); // url -> pem (SNS rotates certs rarely; cache to avoid refetch/event)
async function fetchCert(url) {
  if (_certCache.has(url)) return _certCache.get(url);
  const { statusCode, body } = await httpsGet(url);
  if (statusCode !== 200 || !body) throw new Error('cert fetch failed');
  _certCache.set(url, body);
  return body;
}

async function verifySnsSignature(msg) {
  if (!isAwsSnsUrl(msg.SigningCertURL, true)) return false;
  const canonical = snsCanonicalString(msg);
  if (!canonical || !msg.Signature) return false;
  const pem = await fetchCert(msg.SigningCertURL);
  const algo = msg.SignatureVersion === '2' ? 'RSA-SHA256' : 'RSA-SHA1';
  const verifier = crypto.createVerify(algo);
  verifier.update(canonical, 'utf8');
  return verifier.verify(pem, msg.Signature, 'base64');
}

// Apply one SES event (inside the SNS Message payload) to the matching row.
async function applySesEvent(snsMsg) {
  let event;
  try { event = JSON.parse(snsMsg.Message); } catch { return; }
  const sesMessageId = event.mail && event.mail.messageId;
  if (!sesMessageId) return;
  const row = await db.findEmailBySesMessageId(sesMessageId);
  if (!row) return; // not one of ours (or predates sesMessageId capture)

  // Config-set events use eventType; legacy SNS identity notifications use notificationType.
  const type = event.eventType || event.notificationType;
  const rowAddr = String(row.toAddr || '').toLowerCase();
  const inList = (arr) => {
    const set = (arr || []).map(r => String((r && r.emailAddress) || '').toLowerCase());
    return set.length === 0 || set.includes(rowAddr);
  };

  if (type === 'Bounce' && event.bounce) {
    const b = event.bounce;
    if (!inList(b.bouncedRecipients)) return;
    const first = (b.bouncedRecipients || [])[0] || {};
    const reason = first.diagnosticCode || `${b.bounceType || 'Bounce'}/${b.bounceSubType || ''}`;
    await db.markEmailBounced(row.id, { bounceType: b.bounceType, bounceSubType: b.bounceSubType, reason });
  } else if (type === 'Complaint' && event.complaint) {
    const c = event.complaint;
    if (!inList(c.complainedRecipients)) return;
    await db.markEmailComplained(row.id, { reason: c.complaintFeedbackType || 'complaint' });
  } else if (type === 'Delivery' && event.delivery) {
    await db.markEmailDelivered(row.id);
  }
}

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

// SNS posts text/plain, so parse the body as text on THIS route only. Always
// answers 200 (except on auth/signature failure) so SNS doesn't retry-storm on a
// transient handler error.
router.post('/ses-events', express.text({ type: '*/*', limit: '512kb' }), asyncHandler(async (req, res) => {
  const expected = process.env.SES_EVENTS_KEY;
  if (!expected || req.query.key !== expected) {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }
  let msg;
  try { msg = JSON.parse(req.body); } catch (e) {
    return res.status(400).json({ ok: false, error: 'Bad JSON' });
  }

  let verified = false;
  try { verified = await verifySnsSignature(msg); } catch (e) { verified = false; }
  if (!verified) {
    console.warn('SES events: SNS signature verification failed');
    return res.status(403).json({ ok: false, error: 'Bad signature' });
  }

  if (msg.Type === 'SubscriptionConfirmation') {
    // Confirm the subscription by GETting SubscribeURL (validated as a real SNS URL).
    if (isAwsSnsUrl(msg.SubscribeURL, false)) {
      try { await httpsGet(msg.SubscribeURL); }
      catch (e) { console.error('SES events: SubscribeURL fetch failed:', e.message); }
    }
    return res.status(200).json({ ok: true, confirmed: true });
  }

  if (msg.Type === 'Notification') {
    try { await applySesEvent(msg); }
    catch (e) { console.error('SES events: apply failed:', e.message); }
  }
  return res.status(200).json({ ok: true });
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
