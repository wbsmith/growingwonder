// Outbound engine tests. These prove the privacy + tracking guarantees of the SES
// send path WITHOUT sending real mail: the SES client and the DynamoDB client are
// both stubbed (same pattern as test/pagination.test.js). Covers the Compose
// fan-out (N single-recipient rows, shared batchId, per-recipient failure
// isolation, suppression skip), the From-selection fixes (H1 fallback / H4 throw),
// and confirmation auto-send (marks sent/failed).
const { test } = require('node:test');
const assert = require('node:assert');

process.env.WIW_AWS_REGION = 'us-west-1';
process.env.WIW_ACCESS_KEY_ID = 'test';
process.env.WIW_SECRET_ACCESS_KEY = 'test';
process.env.SES_FROM_EMAIL_REG = 'registration@worldinwonder.com';
process.env.SES_FROM_EMAIL_INFO = 'info@worldinwonder.com';
process.env.EMAILS_CACHE_TTL_MS = '0'; // never serve a stale cached scan mid-test

// ---- In-memory DynamoDB (Document client) ----
const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
let STORE = null;
DynamoDBDocumentClient.prototype.send = async function (command) {
  if (!STORE) throw new Error('test issued an unexpected DynamoDB call');
  return STORE.handler(command.constructor.name, command.input);
};

// Minimal emulation of the equality + attribute_not_exists filters our db layer
// uses, plus SET UpdateExpressions, so scans reflect prior writes.
function makeStore(initialRows = []) {
  const rows = new Map(initialRows.map(r => [r.id, { ...r }]));
  const puts = [];
  const matches = (row, expr, names = {}, values = {}) => {
    if (!expr) return true;
    return expr.split(/\s+AND\s+/).every(raw => {
      const clause = raw.trim();
      let m = clause.match(/^attribute_not_exists\((\S+)\)$/);
      if (m) { let a = m[1]; if (a.startsWith('#')) a = names[a]; return row[a] === undefined || row[a] === null; }
      m = clause.match(/^(\S+)\s*=\s*(:\w+)$/);
      if (m) { let a = m[1]; if (a.startsWith('#')) a = names[a]; return row[a] === values[m[2]]; }
      return true;
    });
  };
  const applySet = (row, input) => {
    const names = input.ExpressionAttributeNames || {};
    const values = input.ExpressionAttributeValues || {};
    const sm = input.UpdateExpression.match(/SET\s+(.+?)(?:\s+REMOVE\s+|$)/i);
    if (!sm) return;
    for (const clause of sm[1].split(',')) {
      const m = clause.trim().match(/^(\S+)\s*=\s*(:\w+)$/);
      if (!m) continue;
      let a = m[1]; if (a.startsWith('#')) a = names[a] || a;
      row[a] = values[m[2]];
    }
  };
  const handler = async (name, input) => {
    if (name === 'ScanCommand') {
      const items = [...rows.values()].filter(r => matches(r, input.FilterExpression, input.ExpressionAttributeNames, input.ExpressionAttributeValues));
      return { Items: items };
    }
    if (name === 'GetCommand') return { Item: rows.get(input.Key.id) || null };
    if (name === 'PutCommand') { rows.set(input.Item.id, { ...input.Item }); puts.push(input.Item); return {}; }
    if (name === 'UpdateCommand') {
      const row = rows.get(input.Key.id) || { id: input.Key.id };
      applySet(row, input); rows.set(row.id, row); return {};
    }
    throw new Error('unexpected DynamoDB command in test: ' + name);
  };
  return { handler, rows, puts };
}

// ---- SES stub ----
const { SESClient } = require('@aws-sdk/client-ses');
let SES_HANDLER = null;
SESClient.prototype.send = async function (command) {
  if (!SES_HANDLER) throw new Error('test issued an unexpected SES call');
  return SES_HANDLER(command);
};
// Parse the single To: recipient out of a raw MIME message (privacy assertion).
function toRecipient(command) {
  const raw = Buffer.from(command.input.RawMessage.Data).toString();
  const line = raw.split('\r\n').find(l => l.startsWith('To: '));
  return line ? line.slice(4).trim() : null;
}

const outbound = require('../lib/outbound');
const mailer = require('../lib/mailer');
const smtp = require('../lib/smtp');

test('Compose fan-out: N single-recipient rows sharing one batchId (privacy)', async () => {
  STORE = makeStore();
  const sentTo = [];
  let n = 0;
  SES_HANDLER = (cmd) => { sentTo.push(toRecipient(cmd)); return { MessageId: 'ses-' + (++n) }; };

  const res = await outbound.sendCompose({
    recipients: ['a@x.com', 'b@x.com', 'c@x.com'],
    subject: 'Hi', body: 'Hello', purpose: 'info',
  });

  assert.deepStrictEqual({ sent: res.sent, failed: res.failed, suppressed: res.suppressed, total: res.total },
    { sent: 3, failed: 0, suppressed: 0, total: 3 });
  // Every SES message went to exactly one recipient.
  assert.deepStrictEqual(sentTo.sort(), ['a@x.com', 'b@x.com', 'c@x.com']);
  // Exactly 3 rows, each with a single string toAddr and no bcc/multi field.
  assert.strictEqual(STORE.puts.length, 3);
  for (const row of STORE.puts) {
    assert.strictEqual(typeof row.toAddr, 'string');
    assert.ok(!row.toAddr.includes(','), 'toAddr must be a single address');
    assert.strictEqual(row.bcc, undefined, 'no BCC field may exist on a row');
    assert.strictEqual(row.status, 'sent');
    assert.ok(row.sesMessageId, 'row records the SES MessageId');
  }
  const batchIds = new Set(STORE.puts.map(r => r.batchId));
  assert.strictEqual(batchIds.size, 1, 'all rows share exactly one batchId');
});

test('Compose fan-out: one recipient failing does not abort the batch', async () => {
  STORE = makeStore();
  SES_HANDLER = (cmd) => {
    if (toRecipient(cmd) === 'bad@x.com') throw new Error('554 rejected');
    return { MessageId: 'ses-ok' };
  };
  const res = await outbound.sendCompose({
    recipients: ['good1@x.com', 'bad@x.com', 'good2@x.com'],
    subject: 'S', body: 'B', purpose: 'info',
  });
  assert.deepStrictEqual({ sent: res.sent, failed: res.failed }, { sent: 2, failed: 1 });
  const failed = STORE.puts.filter(r => r.status === 'failed');
  assert.strictEqual(failed.length, 1);
  assert.strictEqual(failed[0].toAddr, 'bad@x.com');
  assert.match(failed[0].failureReason, /554 rejected/);
  assert.strictEqual(STORE.puts.filter(r => r.status === 'sent').length, 2);
});

test('Compose fan-out: a suppressed address is skipped (no send, row=suppressed)', async () => {
  // Seed a prior permanent bounce so getSuppressedAddresses() includes it.
  STORE = makeStore([
    { id: 'old', toAddr: 'blocked@x.com', status: 'bounced', bounceType: 'Permanent' },
  ]);
  const sentTo = [];
  SES_HANDLER = (cmd) => { sentTo.push(toRecipient(cmd)); return { MessageId: 'ses-x' }; };

  const res = await outbound.sendCompose({
    recipients: ['ok@x.com', 'blocked@x.com'],
    subject: 'S', body: 'B', purpose: 'info',
  });
  assert.deepStrictEqual({ sent: res.sent, suppressed: res.suppressed }, { sent: 1, suppressed: 1 });
  assert.deepStrictEqual(sentTo, ['ok@x.com'], 'suppressed address must never hit SES');
  const supRow = STORE.puts.find(r => r.toAddr === 'blocked@x.com');
  assert.strictEqual(supRow.status, 'suppressed');
});

test('Confirmation auto-send marks the row sent on success', async () => {
  STORE = makeStore([{ id: 'C1', toAddr: 'p@x.com', subject: 'Welcome', body: 'Hi', status: 'draft', attachments: [] }]);
  SES_HANDLER = () => ({ MessageId: 'ses-conf' });
  const r = await outbound.sendConfirmation(STORE.rows.get('C1'));
  assert.strictEqual(r.ok, true);
  const row = STORE.rows.get('C1');
  assert.strictEqual(row.status, 'sent');
  assert.strictEqual(row.sesMessageId, 'ses-conf');
  assert.ok(row.fromAddr, 'records the sending identity');
});

test('Confirmation auto-send marks the row failed on SES error', async () => {
  STORE = makeStore([{ id: 'C2', toAddr: 'p@x.com', subject: 'Welcome', body: 'Hi', status: 'draft', attachments: [] }]);
  SES_HANDLER = () => { throw new Error('Throttling: rate exceeded'); };
  const r = await outbound.sendConfirmation(STORE.rows.get('C2'));
  assert.strictEqual(r.ok, false);
  const row = STORE.rows.get('C2');
  assert.strictEqual(row.status, 'failed');
  assert.match(row.failureReason, /Throttling/);
});

test('H1: getFromAddress falls back to the other identity instead of throwing', async () => {
  const savedInfo = process.env.SES_FROM_EMAIL_INFO;
  delete process.env.SES_FROM_EMAIL_INFO; // info unset, reg still set
  try {
    assert.strictEqual(mailer.getFromAddress('info'), 'registration@worldinwonder.com');
    // and neither set -> throws
    const savedReg = process.env.SES_FROM_EMAIL_REG;
    delete process.env.SES_FROM_EMAIL_REG;
    assert.throws(() => mailer.getFromAddress('info'), /not configured/);
    process.env.SES_FROM_EMAIL_REG = savedReg;
  } finally {
    process.env.SES_FROM_EMAIL_INFO = savedInfo;
  }
});

test('H4: smtp.sendReply throws for a specific-but-unconfigured mailbox (no silent fallback)', async () => {
  // No MAIL_* env set -> no mailbox configured. Asking for "info" must throw,
  // NOT silently send as some other mailbox.
  await assert.rejects(
    () => smtp.sendReply({ accountKey: 'info', to: 'x@y.com', subject: 's', text: 'b' }),
    /No mailbox configured for "info"/,
  );
});
