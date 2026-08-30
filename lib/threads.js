'use strict';

// Group inbound + outbound messages (wiw-email-queue rows) into conversation
// threads for the admin Inbox. Extracted verbatim from the inline logic that
// used to live in `GET /admin/messages` so the exact same thread shape is now
// shared by the server render AND the no-reload feed poll (`GET /messages/feed`).
//
// Pure function — never mutates the input `emails` (they may be a shared cached
// array from db.getAllEmails). Returns an array of plain, JSON-serializable
// thread objects, newest-activity first.
//
// The thread key is the registration (preferred) or the counterparty address —
// for inbound that's the sender, for outbound the recipient — so a person's
// whole exchange, sent and received, collapses into one row.
//
// Options:
//   filter   'all' | 'registration' | 'info' | 'unread' | 'confirmations'
//            | 'general' (threads with no registrationId) | 'archived'
//   q        case-insensitive substring search, done in Node (not DynamoDB
//            `contains`), over subject/body/bodyText/fromAddr/fromName/toAddr/
//            parentName/childName
//   archived when true, show ONLY archived threads (the "Archived" chip);
//            otherwise archived threads are hidden EXCEPT those carrying an
//            unsent draft. Archive is message-level (mirrors the deletedAt
//            soft-delete) and a thread is "archived" only when every one of its
//            messages is archived — so any new, non-archived inbound message
//            auto-resurfaces the thread into the default view.

// Statuses that represent a delivery problem (bounced/complained/suppressed are
// added by the separate outbound-delivery workstream; treated as "failed" here
// so the row badge and any future failures view group them together).
const FAILED_STATUSES = new Set(['failed', 'bounced', 'complained', 'suppressed']);

const dir = e => e.direction || 'out';
const counterpartyOf = e => ((dir(e) === 'in' ? e.fromAddr : e.toAddr) || '').toLowerCase();
// Outbound here is always sent from registration@; inbound carries its source.
const mailboxOf = e => (dir(e) === 'in' ? (e.mailbox || 'info') : 'registration');
const tsOf = e => e.receivedAt || e.createdAt || '';

function messageMatches(e, needle) {
  const fields = [e.subject, e.body, e.bodyText, e.fromAddr, e.fromName, e.toAddr, e.parentName, e.childName];
  for (const f of fields) {
    if (f && String(f).toLowerCase().includes(needle)) return true;
  }
  return false;
}

function buildThreads(emails, opts = {}) {
  const { filter = 'all', q = '', archived = false } = opts;
  const needle = (q || '').trim().toLowerCase();

  const threadMap = new Map();
  for (const e of emails) {
    const addr = counterpartyOf(e);
    const key = e.registrationId || ('addr:' + addr);
    let t = threadMap.get(key);
    if (!t) {
      t = {
        key,
        registrationId: e.registrationId || null,
        addr,
        toAddr: addr,            // display label for the row
        childName: e.childName,
        programName: e.programName,
        parentName: e.parentName,
        mailboxes: new Set(),
        _messages: [],
      };
      threadMap.set(key, t);
    }
    t._messages.push(e);
    t.mailboxes.add(mailboxOf(e));
    // Backfill display fields from whichever message carries them.
    if (!t.childName && e.childName) t.childName = e.childName;
    if (!t.programName && e.programName) t.programName = e.programName;
    if (!t.parentName) t.parentName = e.parentName || e.fromName;
  }

  let threads = Array.from(threadMap.values()).map(t => {
    const sorted = t._messages.slice().sort((a, b) => tsOf(a).localeCompare(tsOf(b)));
    const latest = sorted[sorted.length - 1];
    const hasDraft = sorted.some(m => m.status === 'draft');
    const hasFailed = sorted.some(m => FAILED_STATUSES.has(m.status));
    const unreadCount = sorted.filter(m => dir(m) === 'in' && !m.read).length;
    // Archived only when EVERY message is archived; a new non-archived inbound
    // message flips it back into the default view.
    const isArchived = sorted.length > 0 && sorted.every(m => !!m.archivedAt);
    return {
      key: t.key,
      registrationId: t.registrationId,
      addr: t.addr,
      toAddr: t.toAddr,
      childName: t.childName || null,
      programName: t.programName || null,
      parentName: t.parentName || null,
      mailboxes: Array.from(t.mailboxes),
      isRegistration: !!t.registrationId,
      subject: sorted[0].subject,
      messageCount: sorted.length,
      latestDate: tsOf(latest),
      latestStatus: hasDraft ? 'draft' : hasFailed ? 'failed' : latest.status,
      latestDirection: dir(latest),
      latestSnippet: (dir(latest) === 'in' ? (latest.bodyText || '') : (latest.body || '')).replace(/<[^>]*>/g, '').slice(0, 120),
      unreadCount,
      hasDraft,
      archived: isArchived,
      latestId: latest.id,
      firstId: sorted[0].id,
      // Comma-join of these gives the delete/archive form its ids (replaces the
      // old `t.messages.map(m => m.id)` the view used to reach into).
      messageIds: sorted.map(m => m.id),
      _messages: sorted, // internal, for q matching; stripped before return
    };
  });

  // Full-text search (Node-side, case-insensitive). A thread matches when any of
  // its messages match, or its display parent/child name matches.
  if (needle) {
    threads = threads.filter(t =>
      t._messages.some(m => messageMatches(m, needle)) ||
      (t.parentName && t.parentName.toLowerCase().includes(needle)) ||
      (t.childName && t.childName.toLowerCase().includes(needle)));
  }

  // Archive visibility (independent of soft-delete, which db.getAllEmails already
  // filters out).
  if (archived) {
    threads = threads.filter(t => t.archived);
  } else {
    threads = threads.filter(t => !t.archived || t.hasDraft);
  }

  // Filter chips. 'archived' is handled by the `archived` option above; 'all'
  // applies nothing.
  if (filter === 'registration') threads = threads.filter(t => t.mailboxes.includes('registration'));
  else if (filter === 'info') threads = threads.filter(t => t.mailboxes.includes('info'));
  else if (filter === 'unread') threads = threads.filter(t => t.unreadCount > 0);
  else if (filter === 'confirmations') threads = threads.filter(t => t.isRegistration);
  else if (filter === 'general') threads = threads.filter(t => !t.registrationId);

  // Sort: newest activity first, like a normal inbox.
  threads.sort((a, b) => (b.latestDate || '').localeCompare(a.latestDate || ''));

  // Drop the internal message array so the returned objects stay lean and are
  // identical whether emitted by the server render or the JSON feed.
  for (const t of threads) delete t._messages;
  return threads;
}

module.exports = { buildThreads, FAILED_STATUSES };
