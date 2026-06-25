// One-shot migration to per-child dates + head-count capacity.
//
// Background: dates used to live once per registration (`selectedDates`, shared
// by every child) and `wiw-dates.enrolled` counted ONE per family per date.
// Dates now live on each child (`child.dates`) and capacity counts CHILDREN
// (heads) per day. This script reconciles existing data to the new model.
//
//   Phase 1 — give every child `dates = selectedDates` (the old family set).
//   Phase 2 — recompute every wiw-dates `enrolled` as the total head count
//             across all registrations, OVERWRITING the old family-based value.
//
// Both phases are idempotent. Run Phase 1 before Phase 2 conceptually, but the
// head count falls back to `selectedDates`, so a single pass is correct either
// way. Run this once, right after deploying the new code.
//
// Run:  DRY_RUN=1 node db/migrate_per_child_dates.js
//       node db/migrate_per_child_dates.js
//       PROGRAM_ID=prog_01KP... node db/migrate_per_child_dates.js

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient, ScanCommand, UpdateCommand,
} = require('@aws-sdk/lib-dynamodb');

const DRY = !!process.env.DRY_RUN;
const PROGRAM_ID = process.env.PROGRAM_ID || null;
const region = process.env.WIW_AWS_REGION || process.env.AWS_REGION || 'us-west-1';
const clientConfig = { region };
if (process.env.WIW_ACCESS_KEY_ID) {
  clientConfig.credentials = {
    accessKeyId: process.env.WIW_ACCESS_KEY_ID,
    secretAccessKey: process.env.WIW_SECRET_ACCESS_KEY,
  };
}
const client = DynamoDBDocumentClient.from(new DynamoDBClient(clientConfig));

const T = { dates: 'wiw-dates', registrations: 'wiw-registrations' };

async function scanAll(TableName) {
  let items = [];
  let ExclusiveStartKey;
  do {
    const { Items, LastEvaluatedKey } = await client.send(new ScanCommand({ TableName, ExclusiveStartKey }));
    items = items.concat(Items || []);
    ExclusiveStartKey = LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

// date -> heads for one registration. A child-less registration (e.g. CIT) is
// one participant per date; otherwise each child counts on its own dates.
function headCounts(reg) {
  const m = new Map();
  const kids = reg.children || [];
  const sel = reg.selectedDates || [];
  if (kids.length === 0) {
    for (const d of sel) m.set(d, (m.get(d) || 0) + 1);
    return m;
  }
  for (const c of kids) {
    const dates = Array.isArray(c.dates) ? c.dates : sel;
    for (const d of dates) m.set(d, (m.get(d) || 0) + 1);
  }
  return m;
}

(async () => {
  const regs = await scanAll(T.registrations);
  const scoped = PROGRAM_ID ? regs.filter(r => r.programId === PROGRAM_ID) : regs;
  console.log(`Scanned ${regs.length} registration(s)${PROGRAM_ID ? `; ${scoped.length} in ${PROGRAM_ID}` : ''}.`);

  // ---- Phase 1: backfill child.dates ----
  let backfilled = 0;
  for (const reg of scoped) {
    const kids = reg.children || [];
    if (kids.length === 0) continue; // child-less: keep family selectedDates as-is
    if (kids.every(c => Array.isArray(c.dates))) continue; // already migrated
    const newChildren = kids.map(c => (
      Array.isArray(c.dates) ? c : { ...c, dates: [...(reg.selectedDates || [])] }
    ));
    console.log(`  reg ${reg.id} (${reg.parentName || 'no name'}): backfill ${kids.length} child(ren) with ${(reg.selectedDates || []).length} date(s)`);
    if (!DRY) {
      await client.send(new UpdateCommand({
        TableName: T.registrations,
        Key: { id: reg.id },
        UpdateExpression: 'SET children = :c',
        ExpressionAttributeValues: { ':c': newChildren },
      }));
    }
    backfilled++;
  }
  console.log(`Phase 1: ${backfilled} registration(s) ${DRY ? 'would be' : ''} backfilled.`);

  // ---- Phase 2: recompute enrolled (heads) ----
  const headByKey = {}; // `${programId}|${date}` -> heads
  for (const reg of regs) {
    if (!reg.programId || reg.programId === 'imported') continue;
    if (PROGRAM_ID && reg.programId !== PROGRAM_ID) continue;
    for (const [date, n] of headCounts(reg)) {
      const k = reg.programId + '|' + date;
      headByKey[k] = (headByKey[k] || 0) + n;
    }
  }

  const dateRows = (await scanAll(T.dates)).filter(d => !PROGRAM_ID || d.programId === PROGRAM_ID);
  let changed = 0;
  const overCap = [];
  for (const d of dateRows.sort((a, b) => (a.programId + a.date).localeCompare(b.programId + b.date))) {
    const target = headByKey[d.programId + '|' + d.date] || 0;
    if ((d.enrolled || 0) !== target) {
      console.log(`  ${d.programId}  ${d.date}  enrolled ${d.enrolled ?? 0} -> ${target}`);
      changed++;
      if (!DRY) {
        await client.send(new UpdateCommand({
          TableName: T.dates,
          Key: { programId: d.programId, date: d.date },
          UpdateExpression: 'SET enrolled = :e',
          ExpressionAttributeValues: { ':e': target },
        }));
      }
    }
    if (d.maxCapacity != null && target > d.maxCapacity) {
      overCap.push({ programId: d.programId, date: d.date, enrolled: target, maxCapacity: d.maxCapacity });
    }
  }
  console.log(`Phase 2: ${changed} date counter(s) ${DRY ? 'would be' : ''} updated.`);

  if (overCap.length > 0) {
    console.log(`\nWARNING: ${overCap.length} date(s) now exceed capacity (correct data — multi-child families were undercounted before; consider raising capacity):`);
    for (const o of overCap) console.log(`  ${o.programId}  ${o.date}  ${o.enrolled}/${o.maxCapacity}`);
  }

  if (DRY) console.log('\nDRY RUN — no writes performed. Re-run without DRY_RUN=1 to apply.');
  else console.log('\nDone.');
})().catch(e => { console.error(e); process.exit(1); });
