// Pulls inbound mail from the Namecheap mailboxes (registration@, info@) over
// IMAP and mirrors it into the wiw-email-queue table as direction:'in' rows, so
// replies appear in the admin inbox/threads. Read-only against IMAP — never
// deletes or moves mail; the Namecheap mailbox stays the source of truth.
//
// Stateless incremental sync: the high-water mark is derived from rows already
// stored (max IMAP uid per uidvalidity), so there's no cursor table to keep in
// sync. First run for a mailbox pulls a bounded recent window; later runs fetch
// only uids above the last stored one.
//
// Designed to run on demand (admin "Refresh" / page open) since the app runs on
// Amplify compute (Lambda) with no long-lived background process. The same
// entry point can be driven by a scheduled trigger (see routes/api.js cron).

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const crypto = require('crypto');
const db = require('../db/dynamo');
const mailConfig = require('./mail-config');
const storage = require('./storage');

// Deterministic row id per (mailbox, message) so a message pulled more than once
// — e.g. by two sync runs racing (auto-refresh + manual Refresh) — overwrites the
// same item instead of creating a duplicate. Idempotent regardless of concurrency.
function inboundId(mailbox, messageId) {
  return 'in_' + crypto.createHash('sha1').update(mailbox + '|' + messageId).digest('hex');
}

const FIRST_RUN_DAYS = parseInt(process.env.MAIL_FIRST_RUN_DAYS, 10) || 90;
const MAX_PER_SYNC = parseInt(process.env.MAIL_MAX_PER_SYNC, 10) || 100;
const CONNECT_TIMEOUT_MS = parseInt(process.env.MAIL_CONNECT_TIMEOUT_MS, 10) || 15000;

function toArray(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : String(v).split(/\s+/);
}

function normalizeId(id) {
  return (id || '').toString().trim();
}

function stripHtml(html) {
  return (html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<\/(p|div|br|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Build a registration-resolution index once per sync run (avoids a table scan
// per inbound message). Maps outbound Message-IDs and recipient addresses to the
// registration they belong to.
async function buildResolver() {
  const all = await db.getAllEmails();
  const byMessageId = new Map();
  const byToAddr = new Map();
  for (const e of all) {
    if (!e.registrationId) continue;
    if (e.messageId) byMessageId.set(normalizeId(e.messageId), e.registrationId);
    const to = (e.toAddr || '').toLowerCase();
    if (to) {
      const prev = byToAddr.get(to);
      if (!prev || (e.createdAt || '') > prev.createdAt) {
        byToAddr.set(to, { registrationId: e.registrationId, createdAt: e.createdAt || '' });
      }
    }
  }
  return { byMessageId, byToAddr };
}

async function buildInboundRecord(account, uidValidity, msg, state, resolver) {
  const parsed = await simpleParser(msg.source);
  const messageId = normalizeId(parsed.messageId) || `imap-${account.key}-${uidValidity}-${msg.uid}`;
  if (state.messageIds.has(messageId)) return null; // dedup against already-stored

  const fromObj = (parsed.from && parsed.from.value && parsed.from.value[0]) || {};
  const fromAddr = (fromObj.address || '').toLowerCase();
  const inReplyTo = normalizeId(parsed.inReplyTo);
  const references = toArray(parsed.references).map(normalizeId).filter(Boolean);

  // Thread resolution: exact header match first, then most-recent registration
  // addressed to this sender. Either may be null -> stays an address-only thread.
  let registrationId = null;
  for (const mid of [inReplyTo, ...references]) {
    if (mid && resolver.byMessageId.has(mid)) { registrationId = resolver.byMessageId.get(mid); break; }
  }
  if (!registrationId && fromAddr && resolver.byToAddr.has(fromAddr)) {
    registrationId = resolver.byToAddr.get(fromAddr).registrationId;
  }

  // Attachments -> S3 (best-effort; a failed upload just drops that attachment).
  const attachments = [];
  for (const att of parsed.attachments || []) {
    if (!att.content) continue;
    try {
      const filename = att.filename || 'attachment';
      const up = await storage.putBuffer('inbound-attachments', filename, att.content, att.contentType);
      attachments.push({ filename, url: up.publicUrl, key: up.key, contentType: att.contentType, size: att.size });
    } catch (_) { /* skip this attachment */ }
  }

  const receivedAt = (msg.internalDate || parsed.date || new Date()).toISOString();
  return {
    id: inboundId(account.key, messageId),
    direction: 'in',
    mailbox: account.key,
    fromAddr,
    fromName: fromObj.name || '',
    toAddr: account.user,
    subject: parsed.subject || '(no subject)',
    bodyText: parsed.text || stripHtml(parsed.html),
    messageId,
    inReplyTo,
    references,
    imapUid: msg.uid,
    imapUidValidity: parseInt(uidValidity, 10),
    registrationId: registrationId || null,
    status: 'received',
    read: false,
    attachments,
    receivedAt,
    createdAt: receivedAt,
  };
}

async function syncMailbox(account, resolver) {
  const state = await db.getInboundState(account.key);
  const client = new ImapFlow({ ...mailConfig.imapConnectionFor(account), socketTimeout: CONNECT_TIMEOUT_MS });
  let stored = 0;
  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const uidValidity = String(client.mailbox.uidValidity);
      const lastUid = state.maxUidByValidity[uidValidity] || 0;

      // Find candidate UIDs cheaply (search returns ids only), then download the
      // full source for just the capped batch — so a large backlog doesn't pull
      // every message body every run.
      let candidateUids;
      if (lastUid > 0) {
        candidateUids = await client.search({ uid: `${lastUid + 1}:*` }, { uid: true });
        candidateUids = (candidateUids || []).filter(u => u > lastUid);
      } else {
        const since = new Date(Date.now() - FIRST_RUN_DAYS * 86400000);
        candidateUids = (await client.search({ since }, { uid: true })) || [];
      }
      candidateUids.sort((a, b) => a - b);

      // Process OLDEST-first and cap per run. Advancing the cursor only past the
      // batch we actually stored means a large backlog is caught up gap-free
      // over successive runs (rather than jumping to the newest and orphaning
      // everything in between).
      const batch = candidateUids.slice(0, MAX_PER_SYNC);
      const pending = candidateUids.length - batch.length;
      if (pending > 0) {
        console.log(`IMAP sync ${account.key}: storing ${batch.length}, ${pending} older message(s) still pending (run Refresh again).`);
      }
      if (batch.length === 0) return { mailbox: account.key, stored: 0, pending: 0 };

      for await (const msg of client.fetch(batch.join(','), { uid: true, source: true, internalDate: true }, { uid: true })) {
        const rec = await buildInboundRecord(account, uidValidity, msg, state, resolver);
        if (rec) {
          await db.createInboundEmail(rec);
          state.messageIds.add(rec.messageId);
          stored++;
        }
      }
      return { mailbox: account.key, stored, pending };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

// Sync every configured mailbox. Mailboxes run sequentially to keep one IMAP
// connection open at a time (gentler on Lambda memory and the mail server).
async function syncAllMailboxes() {
  const accounts = mailConfig.configuredAccounts();
  if (accounts.length === 0) return { configured: false, total: 0, results: [] };
  const resolver = await buildResolver();
  const results = [];
  for (const account of accounts) {
    try {
      results.push(await syncMailbox(account, resolver));
    } catch (e) {
      console.error(`IMAP sync failed for ${account.key}:`, e.message);
      results.push({ mailbox: account.key, stored: 0, error: e.message });
    }
  }
  const total = results.reduce((n, r) => n + (r.stored || 0), 0);
  return { configured: true, total, results };
}

module.exports = { syncAllMailboxes, syncMailbox };
