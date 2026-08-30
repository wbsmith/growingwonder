// Outbound send engine (SES path). Consolidates the confirmation send and the
// Compose fan-out so every send is recorded with its correlation key
// (sesMessageId) and delivery outcome can be tracked. Replies stay on SMTP
// (lib/smtp.js) — this module is only the SES-authenticated confirmations +
// compose path.
//
// Privacy guarantee for Compose: sends are an INDIVIDUAL per-recipient fan-out.
// Each recipient gets its own message (fresh Message-ID) and its own outbound row
// with a SINGLE toAddr — never a BCC/multi-recipient row. So recipients can never
// see each other, and each send is independently trackable/threadable.

const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { ulid } = require('ulid');
const db = require('../db/dynamo');
const mailer = require('./mailer');

const region = process.env.WIW_AWS_REGION || process.env.AWS_REGION || 'us-west-1';
const s3Config = { region };
if (process.env.WIW_ACCESS_KEY_ID) {
  s3Config.credentials = {
    accessKeyId: process.env.WIW_ACCESS_KEY_ID,
    secretAccessKey: process.env.WIW_SECRET_ACCESS_KEY,
  };
}
let _s3 = null;
function s3() { return _s3 || (_s3 = new S3Client(s3Config)); }
function bucket() { return process.env.WIW_S3_BUCKET || 'wiw-media-assets'; }

// Pull stored attachment objects from S3 into in-memory buffers for the MIME
// builder. Dedupes the S3-fetch code previously inlined in routes/admin.js.
// keys: [{ key, filename, contentType }]
async function fetchAttachments(keys) {
  const out = [];
  for (const att of (keys || [])) {
    if (!att || !att.key) continue;
    const obj = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: att.key }));
    const chunks = [];
    for await (const chunk of obj.Body) chunks.push(chunk);
    out.push({ filename: att.filename, content: Buffer.concat(chunks), contentType: att.contentType });
  }
  return out;
}

// Send a single queued confirmation row via SES and flip its status. Best-effort:
// resolves either way (returns {ok}), never throws, so the caller (registration)
// can proceed regardless. Marks the row sent (with sesMessageId + fromAddr) or
// failed (with reason).
async function sendConfirmation(email) {
  const purpose = 'registration';
  try {
    const attachments = await fetchAttachments(email.attachments || []);
    const format = email.bodyFormat === 'html' ? 'html' : 'text';
    const r = await mailer.send(email.toAddr, email.subject, email.body, purpose, attachments, format);
    await db.markEmailSent(email.id, r && r.messageId, {
      sesMessageId: r && r.sesMessageId,
      fromAddr: mailer.getFromAddress(purpose),
    });
    return { ok: true, sesMessageId: r && r.sesMessageId };
  } catch (err) {
    await db.markEmailFailed(email.id, err.message);
    return { ok: false, error: err.message };
  }
}

// Normalize + dedupe a recipient list (case-insensitive, first occurrence wins).
function normalizeRecipients(recipients) {
  const seen = new Set();
  const list = [];
  for (const raw of (recipients || [])) {
    const addr = String(raw || '').trim();
    if (!addr) continue;
    const low = addr.toLowerCase();
    if (seen.has(low)) continue;
    seen.add(low);
    list.push(addr);
  }
  return list;
}

// Compose fan-out: one private message per recipient. Mints a shared batchId,
// fetches attachments once, loads the suppression list once. Per recipient:
//   - suppressed (prior permanent bounce / complaint) -> row 'suppressed', no send
//   - otherwise SES send with a fresh per-recipient Message-ID -> row 'sent'
//   - per-recipient SES error -> row 'failed' + reason, continue the batch
// Every row carries a single toAddr (privacy), the batchId, and fromAddr.
// Returns { batchId, sent, failed, suppressed, total }.
async function sendCompose({ recipients, subject, body, format = 'text', attachmentKeys = [], purpose = 'info' }) {
  const batchId = ulid();
  const list = normalizeRecipients(recipients);
  const [attachments, suppressed] = await Promise.all([
    fetchAttachments(attachmentKeys),
    db.getSuppressedAddresses(),
  ]);
  const fromAddr = mailer.getFromAddress(purpose);
  const result = { batchId, sent: 0, failed: 0, suppressed: 0, total: list.length };

  for (const to of list) {
    const now = new Date().toISOString();
    const base = {
      id: ulid(),
      direction: 'out',
      registrationId: null,
      toAddr: to, // SINGLE recipient per row — the privacy guarantee
      mailbox: purpose,
      subject,
      body,
      batchId,
      fromAddr,
      createdAt: now,
    };
    if (format === 'html') base.bodyFormat = 'html';

    if (suppressed.has(to.toLowerCase())) {
      await db.createOutboundEmail({
        ...base, status: 'suppressed',
        failureReason: 'Address on suppression list (prior permanent bounce or complaint).',
      });
      result.suppressed++;
      continue;
    }
    try {
      const r = await mailer.send(to, subject, body, purpose, attachments, format);
      await db.createOutboundEmail({
        ...base, status: 'sent', sentAt: now,
        messageId: r && r.messageId, sesMessageId: r && r.sesMessageId,
      });
      result.sent++;
    } catch (err) {
      await db.createOutboundEmail({
        ...base, status: 'failed', failureReason: err.message,
      });
      result.failed++;
    }
  }
  return result;
}

module.exports = { fetchAttachments, sendConfirmation, sendCompose, normalizeRecipients };
