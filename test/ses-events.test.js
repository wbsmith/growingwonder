// SES delivery webhook tests (POST /api/ses-events). No real AWS: DynamoDB is
// stubbed, https.get is stubbed, and SNS messages are signed with a keypair we
// generate here so the REAL crypto signature check runs end-to-end. Drives the
// route through the live Express app over HTTP.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

process.env.WIW_AWS_REGION = 'us-west-1';
process.env.WIW_ACCESS_KEY_ID = 'test';
process.env.WIW_SECRET_ACCESS_KEY = 'test';
process.env.SES_EVENTS_KEY = 'secret-key';
process.env.EMAILS_CACHE_TTL_MS = '0';

// ---- signing keypair (stands in for the SNS SigningCert) ----
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const CERT_PEM = publicKey.export({ type: 'spki', format: 'pem' });
const CERT_URL = 'https://sns.us-west-1.amazonaws.com/SimpleNotificationService-test.pem';

const SIGN_KEYS = {
  Notification: ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'],
  SubscriptionConfirmation: ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'],
};
function signSnsMessage(msg) {
  let canonical = '';
  for (const k of SIGN_KEYS[msg.Type]) {
    if (msg[k] === undefined || msg[k] === null) continue;
    canonical += k + '\n' + msg[k] + '\n';
  }
  const signer = crypto.createSign('RSA-SHA1');
  signer.update(canonical, 'utf8');
  msg.SignatureVersion = '1';
  msg.SigningCertURL = CERT_URL;
  msg.Signature = signer.sign(privateKey, 'base64');
  return msg;
}

// ---- stub https.get (cert fetch + SubscribeURL confirm) ----
const https = require('node:https');
const fetchedUrls = [];
https.get = function (url, cb) {
  fetchedUrls.push(url);
  const res = new EventEmitter();
  res.statusCode = 200;
  const body = String(url).endsWith('.pem') ? CERT_PEM : 'ok';
  process.nextTick(() => { cb(res); res.emit('data', body); res.emit('end'); });
  return new EventEmitter(); // supports .on('error', ...)
};

// ---- in-memory DynamoDB ----
const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
let STORE = null;
DynamoDBDocumentClient.prototype.send = async function (command) {
  if (!STORE) throw new Error('unexpected DynamoDB call');
  return STORE.handler(command.constructor.name, command.input);
};
function makeStore(initialRows = []) {
  const rows = new Map(initialRows.map(r => [r.id, { ...r }]));
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
    if (name === 'ScanCommand') return { Items: [...rows.values()].filter(r => matches(r, input.FilterExpression, input.ExpressionAttributeNames, input.ExpressionAttributeValues)) };
    if (name === 'GetCommand') return { Item: rows.get(input.Key.id) || null };
    if (name === 'PutCommand') { rows.set(input.Item.id, { ...input.Item }); return {}; }
    if (name === 'UpdateCommand') { const row = rows.get(input.Key.id) || { id: input.Key.id }; applySet(row, input); rows.set(row.id, row); return {}; }
    throw new Error('unexpected DynamoDB command in test: ' + name);
  };
  return { handler, rows };
}

const app = require('../app');
const db = require('../db/dynamo');
let server, base;

before(async () => {
  server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());

function postEvents(bodyObj, key = 'secret-key') {
  return fetch(`${base}/api/ses-events?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj),
  });
}

test('wrong key -> 403 (before any parsing)', async () => {
  STORE = makeStore();
  const res = await postEvents({ Type: 'Notification' }, 'wrong');
  assert.strictEqual(res.status, 403);
});

test('SubscriptionConfirmation with a valid signature -> 200 and fetches SubscribeURL', async () => {
  STORE = makeStore();
  fetchedUrls.length = 0;
  const subUrl = 'https://sns.us-west-1.amazonaws.com/?Action=ConfirmSubscription&Token=abc';
  const msg = signSnsMessage({
    Type: 'SubscriptionConfirmation', MessageId: 'm-sub', Token: 'abc',
    TopicArn: 'arn:aws:sns:us-west-1:1:wiw-ses-events', SubscribeURL: subUrl,
    Message: 'You have chosen to subscribe', Timestamp: '2026-08-29T00:00:00.000Z',
  });
  const res = await postEvents(msg);
  assert.strictEqual(res.status, 200);
  assert.ok(fetchedUrls.includes(subUrl), 'must GET the SubscribeURL to confirm');
});

test('a tampered signature -> 403', async () => {
  STORE = makeStore();
  const msg = signSnsMessage({
    Type: 'Notification', MessageId: 'm-bad',
    TopicArn: 'arn:aws:sns:us-west-1:1:wiw-ses-events',
    Message: JSON.stringify({ eventType: 'Delivery', mail: { messageId: 'z' }, delivery: {} }),
    Timestamp: '2026-08-29T00:00:00.000Z',
  });
  msg.Message = JSON.stringify({ eventType: 'Delivery', mail: { messageId: 'TAMPERED' }, delivery: {} });
  const res = await postEvents(msg);
  assert.strictEqual(res.status, 403);
});

test('bounce Notification marks the row bounced and populates suppression', async () => {
  STORE = makeStore([{ id: 'R1', toAddr: 'blocked@x.com', sesMessageId: 'ses-bounce-1', status: 'sent' }]);
  const inner = JSON.stringify({
    eventType: 'Bounce',
    mail: { messageId: 'ses-bounce-1' },
    bounce: {
      bounceType: 'Permanent', bounceSubType: 'General',
      bouncedRecipients: [{ emailAddress: 'blocked@x.com', diagnosticCode: 'smtp; 550 5.1.1 user unknown' }],
    },
  });
  const msg = signSnsMessage({
    Type: 'Notification', MessageId: 'm-b', TopicArn: 'arn:aws:sns:us-west-1:1:wiw-ses-events',
    Message: inner, Timestamp: '2026-08-29T00:00:00.000Z',
  });
  const res = await postEvents(msg);
  assert.strictEqual(res.status, 200);

  const row = STORE.rows.get('R1');
  assert.strictEqual(row.status, 'bounced');
  assert.strictEqual(row.bounceType, 'Permanent');
  assert.match(row.failureReason, /550/);

  const suppressed = await db.getSuppressedAddresses();
  assert.ok(suppressed.has('blocked@x.com'), 'permanent bounce feeds the suppression set');
});

test('complaint Notification marks the row complained', async () => {
  STORE = makeStore([{ id: 'R2', toAddr: 'angry@x.com', sesMessageId: 'ses-c-1', status: 'sent' }]);
  const inner = JSON.stringify({
    eventType: 'Complaint',
    mail: { messageId: 'ses-c-1' },
    complaint: { complainedRecipients: [{ emailAddress: 'angry@x.com' }], complaintFeedbackType: 'abuse' },
  });
  const msg = signSnsMessage({
    Type: 'Notification', MessageId: 'm-c', TopicArn: 'arn:aws:sns:us-west-1:1:wiw-ses-events',
    Message: inner, Timestamp: '2026-08-29T00:00:00.000Z',
  });
  const res = await postEvents(msg);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(STORE.rows.get('R2').status, 'complained');
});
