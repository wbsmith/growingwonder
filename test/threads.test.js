// Inbox thread-building + triage tests.
//
// buildThreads (lib/threads.js) is the shared grouping used by both the server
// render of GET /admin/messages and the no-reload JSON feed, so its grouping,
// full-text search, and archive semantics must stay locked down. The archive db
// helpers are exercised against the same DynamoDB stub pattern as
// test/pagination.test.js.
//
// Run: npm test
const { test } = require('node:test');
const assert = require('node:assert');

process.env.WIW_AWS_REGION = 'us-west-1';
process.env.WIW_ACCESS_KEY_ID = 'test';
process.env.WIW_SECRET_ACCESS_KEY = 'test';

const { buildThreads } = require('../lib/threads');

// Intercept every DynamoDB call for the db-helper tests below.
const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
let HANDLER = null;
DynamoDBDocumentClient.prototype.send = async function (command) {
  if (!HANDLER) throw new Error('test issued an unexpected DynamoDB call');
  return HANDLER(command.constructor.name, command.input);
};
const db = require('../db/dynamo');

// A registration thread (outbound draft + inbound reply) and an unlinked info@
// address thread — the two shapes the inbox groups.
function sampleEmails() {
  return [
    { id: 'e1', direction: 'out', registrationId: 'r1', toAddr: 'A@X.com', subject: 'Confirmation', body: 'welcome apple', status: 'draft', createdAt: '2026-08-01T10:00:00Z', parentName: 'Alice', childName: 'Amy', programName: 'Camp' },
    { id: 'e2', direction: 'in', registrationId: 'r1', fromAddr: 'a@x.com', bodyText: 'question about banana', mailbox: 'registration', read: false, receivedAt: '2026-08-02T10:00:00Z', subject: 'Re: Confirmation' },
    { id: 'e3', direction: 'in', fromAddr: 'b@y.com', bodyText: 'general inquiry cherry', mailbox: 'info', read: true, receivedAt: '2026-08-03T10:00:00Z', subject: 'Hi' },
  ];
}
const keysOf = (opts) => buildThreads(sampleEmails(), opts).map(t => t.key);

test('buildThreads groups by registration/address with the expected shape', () => {
  const ts = buildThreads(sampleEmails(), {});
  assert.strictEqual(ts.length, 2);
  // Newest activity first: general thread (08-03) then registration (08-02).
  assert.deepStrictEqual(ts.map(t => t.key), ['addr:b@y.com', 'r1']);

  const r1 = ts.find(t => t.key === 'r1');
  assert.strictEqual(r1.messageCount, 2);
  assert.strictEqual(r1.subject, 'Confirmation');          // sorted[0].subject
  assert.strictEqual(r1.isRegistration, true);
  assert.strictEqual(r1.unreadCount, 1);
  assert.strictEqual(r1.latestStatus, 'draft');            // hasDraft wins
  assert.strictEqual(r1.latestDirection, 'in');
  assert.strictEqual(r1.parentName, 'Alice');
  assert.deepStrictEqual(r1.messageIds, ['e1', 'e2']);     // replaces old t.messages
  assert.strictEqual(r1.archived, false);

  const gen = ts.find(t => t.key === 'addr:b@y.com');
  assert.strictEqual(gen.isRegistration, false);
  assert.strictEqual(gen.toAddr, 'b@y.com');
  assert.deepStrictEqual(gen.mailboxes, ['info']);
  assert.strictEqual(gen._messages, undefined, 'internal message array must not leak into the shape');
});

test('q search matches case-insensitively across message + name fields', () => {
  assert.deepStrictEqual(buildThreads(sampleEmails(), { q: 'banana' }).map(t => t.key), ['r1']);   // inbound bodyText
  assert.deepStrictEqual(buildThreads(sampleEmails(), { q: 'apple' }).map(t => t.key), ['r1']);    // outbound body
  assert.deepStrictEqual(buildThreads(sampleEmails(), { q: 'CHERRY' }).map(t => t.key), ['addr:b@y.com']);
  assert.deepStrictEqual(buildThreads(sampleEmails(), { q: 'alice' }).map(t => t.key), ['r1']);    // display parentName
  assert.strictEqual(buildThreads(sampleEmails(), { q: 'zzz-nomatch' }).length, 0);
});

test('filter chips narrow to mailbox / unread / confirmations / general', () => {
  assert.deepStrictEqual(keysOf({ filter: 'registration' }), ['r1']);
  assert.deepStrictEqual(keysOf({ filter: 'info' }), ['addr:b@y.com']);
  assert.deepStrictEqual(keysOf({ filter: 'unread' }), ['r1']);
  assert.deepStrictEqual(keysOf({ filter: 'confirmations' }), ['r1']);
  assert.deepStrictEqual(keysOf({ filter: 'general' }), ['addr:b@y.com']);
});

test('archived threads hide by default and show only under the archived filter', () => {
  const emails = sampleEmails();
  emails[2].archivedAt = '2026-08-04T00:00:00Z'; // archive the whole general thread
  assert.deepStrictEqual(buildThreads(emails, {}).map(t => t.key), ['r1'], 'archived thread hidden by default');
  assert.deepStrictEqual(
    buildThreads(emails, { filter: 'archived', archived: true }).map(t => t.key),
    ['addr:b@y.com'], 'archived filter shows only archived');
});

test('a fully-archived thread with an unsent draft stays in the default view', () => {
  const emails = sampleEmails();
  emails[0].archivedAt = 'x'; // the draft
  emails[1].archivedAt = 'x';
  assert.ok(buildThreads(emails, {}).some(t => t.key === 'r1'), 'draft thread must remain visible');
});

test('a new non-archived inbound message auto-resurfaces an archived thread', () => {
  const emails = sampleEmails();
  emails[2].archivedAt = 'x';
  assert.ok(!buildThreads(emails, {}).some(t => t.key === 'addr:b@y.com'), 'archived while all messages archived');
  emails.push({ id: 'e4', direction: 'in', fromAddr: 'b@y.com', bodyText: 'follow up', mailbox: 'info', read: false, receivedAt: '2026-08-05T10:00:00Z', subject: 'Re: Hi' });
  assert.ok(buildThreads(emails, {}).some(t => t.key === 'addr:b@y.com'), 'resurfaces on new inbound');
});

test('archiveMessages sets archivedAt/archivedBy per id; unarchive removes them', async () => {
  const calls = [];
  HANDLER = (name, input) => { calls.push({ name, input }); return {}; };
  await db.archiveMessages(['a', 'b'], 'tester');
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0].name, 'UpdateCommand');
  assert.match(calls[0].input.UpdateExpression, /SET archivedAt = :ts, archivedBy = :who/);
  assert.strictEqual(calls[0].input.ExpressionAttributeValues[':who'], 'tester');
  assert.strictEqual(calls[0].input.Key.id, 'a');

  calls.length = 0;
  await db.unarchiveMessages(['a']);
  assert.strictEqual(calls.length, 1);
  assert.match(calls[0].input.UpdateExpression, /REMOVE archivedAt, archivedBy/);
});

test('getEmailsByStatuses queries the status-index GSI once per status', async () => {
  const seen = [];
  HANDLER = (name, input) => {
    assert.strictEqual(name, 'QueryCommand');
    assert.strictEqual(input.IndexName, 'status-index');
    const s = input.ExpressionAttributeValues[':s'];
    seen.push(s);
    return { Items: [{ id: s + '-1', status: s, createdAt: '2026-08-01' }] };
  };
  const rows = await db.getEmailsByStatuses(['failed', 'bounced']);
  assert.deepStrictEqual(seen.sort(), ['bounced', 'failed']);
  assert.strictEqual(rows.length, 2);
});

test('getAllEmails memoizes within the TTL and re-scans after invalidation', async () => {
  db.invalidateEmailsCache();
  let scans = 0;
  HANDLER = (name) => {
    if (name === 'ScanCommand') scans++;
    return { Items: [{ id: 'e1', status: 'sent', createdAt: '2026-08-01T00:00:00Z' }] };
  };
  await db.getAllEmails();
  await db.getAllEmails();
  assert.strictEqual(scans, 1, 'second read served from the short-lived cache');
  db.invalidateEmailsCache();
  await db.getAllEmails();
  assert.strictEqual(scans, 2, 'a write-driven invalidation forces a fresh scan');
});
