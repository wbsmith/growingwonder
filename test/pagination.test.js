// Pagination regression tests. DynamoDB returns at most 1 MB per Scan/Query
// page; a single un-paginated call silently truncates once a table crosses that
// (this is what made the inbox drop messages). These tests (a) prove the db
// helpers aggregate every page, and (b) statically guard that no full-table read
// in db/dynamo.js issues a bare, un-paginated Scan/Query.
//
// Run: npm test    (node's built-in runner — no framework dependency)
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

process.env.WIW_AWS_REGION = 'us-west-1';
process.env.WIW_ACCESS_KEY_ID = 'test';
process.env.WIW_SECRET_ACCESS_KEY = 'test';

// Intercept every DynamoDB call; each test installs its own HANDLER.
const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
let HANDLER = null;
DynamoDBDocumentClient.prototype.send = async function (command) {
  if (!HANDLER) throw new Error('test issued an unexpected DynamoDB call');
  return HANDLER(command.constructor.name, command.input);
};
const db = require('../db/dynamo');

// Emulate DynamoDB paging: hand back `pageSize` items at a time, echoing a
// LastEvaluatedKey until exhausted. Honors Select:'COUNT'.
function paginate(items, pageSize) {
  return (input) => {
    const start = input.ExclusiveStartKey ? input.ExclusiveStartKey.__i : 0;
    const slice = items.slice(start, start + pageSize);
    const next = start + pageSize;
    const resp = input.Select === 'COUNT' ? { Count: slice.length } : { Items: slice };
    if (next < items.length) resp.LastEvaluatedKey = { __i: next };
    return resp;
  };
}

test('getAllEmails returns rows from EVERY scan page (the inbox truncation bug)', async () => {
  const emails = [
    { id: 'A', status: 'sent', createdAt: '2026-07-01T00:00:00Z' },
    { id: 'B', status: 'draft', createdAt: '2026-07-02T00:00:00Z' },
    { id: 'C', status: 'sent', createdAt: '2026-07-29T00:00:00Z' }, // lands on page 2
    { id: 'D', status: 'sent', createdAt: '2026-07-15T00:00:00Z', deletedAt: 'x' },
  ];
  const pager = paginate(emails, 2); // page size 2 → C and D are on page 2
  HANDLER = (name, input) => { assert.strictEqual(name, 'ScanCommand'); return pager(input); };

  const ids = (await db.getAllEmails()).map(e => e.id);
  assert.ok(ids.includes('C'), 'a row on page 2 must come back (pre-fix it was dropped)');
  assert.ok(!ids.includes('D'), 'soft-deleted rows stay filtered out');
  assert.deepStrictEqual(new Set(ids), new Set(['A', 'B', 'C']));
});

test('countUnreadInbound sums COUNT across pages', async () => {
  const pager = paginate([{}, {}, {}, {}, {}], 2); // 5 matches → pages of 2,2,1
  HANDLER = (name, input) => { assert.strictEqual(input.Select, 'COUNT'); return pager(input); };
  assert.strictEqual(await db.countUnreadInbound(), 5);
});

test('getDatesByProgram aggregates across query pages', async () => {
  const dates = [{ date: '2026-08-01' }, { date: '2026-08-02' }, { date: '2026-08-03' }];
  const pager = paginate(dates, 2);
  HANDLER = (name, input) => { assert.strictEqual(name, 'QueryCommand'); return pager(input); };
  assert.deepStrictEqual((await db.getDatesByProgram('p')).map(d => d.date), ['2026-08-01', '2026-08-02', '2026-08-03']);
});

test('getRegistrationsByProgram aggregates across query pages', async () => {
  const regs = [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }, { id: 'r4' }];
  const pager = paginate(regs, 3);
  HANDLER = (name, input) => { assert.strictEqual(name, 'QueryCommand'); return pager(input); };
  assert.strictEqual((await db.getRegistrationsByProgram('p')).length, 4);
});

// The rule, enforced: no full-table read may issue a bare Scan/Query. Every
// direct `client.send(new ScanCommand|QueryCommand(...))` must sit inside a
// paginating construct — i.e. an `ExclusiveStartKey` cursor loop must be nearby.
// (paginatedCount uses `new CommandClass(...)`, which this pattern doesn't match.)
test('db/dynamo.js has no un-paginated full-table Scan/Query', () => {
  const src = fs.readFileSync(path.join(__dirname, '../db/dynamo.js'), 'utf8');
  const lines = src.split('\n');
  const offenders = [];
  lines.forEach((line, idx) => {
    if (!/client\.send\(new (Scan|Query)Command\(/.test(line)) return;
    // Look for an ExclusiveStartKey cursor within a small window around the call.
    const from = Math.max(0, idx - 12), to = Math.min(lines.length, idx + 12);
    const windowText = lines.slice(from, to).join('\n');
    if (!/ExclusiveStartKey/.test(windowText)) offenders.push(idx + 1);
  });
  assert.deepStrictEqual(offenders, [],
    `un-paginated Scan/Query at db/dynamo.js line(s) ${offenders.join(', ')} — use scanAll/queryAll/paginatedCount or an ExclusiveStartKey loop`);
});
