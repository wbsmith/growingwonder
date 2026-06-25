// Restore DynamoDB tables from a db/backup_tables.js snapshot (emergency rollback).
//
// Re-puts every backed-up item with PutItem, overwriting the live version. This
// undoes in-place mutations (e.g. the per-child-dates migration: children lose
// their added `dates`, wiw-dates rows get their original `enrolled` back).
//
// CAVEAT: items CREATED after the backup are not in the snapshot, so they are
// left in place (not deleted). After a restore, re-run db/migrate_per_child_dates.js
// (or accept minor counter drift) if new registrations landed in the meantime.
//
// Usage:
//   BACKUP_DIR="$HOME/wiw-backups/2026-06-24" DRY_RUN=1 node db/restore_tables.js
//   BACKUP_DIR=... node db/restore_tables.js wiw-registrations wiw-dates

const fs = require('fs');
const path = require('path');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, BatchWriteCommand } = require('@aws-sdk/lib-dynamodb');

const DRY = !!process.env.DRY_RUN;
const region = process.env.WIW_AWS_REGION || process.env.AWS_REGION || 'us-west-1';
const clientConfig = { region };
if (process.env.WIW_ACCESS_KEY_ID) {
  clientConfig.credentials = {
    accessKeyId: process.env.WIW_ACCESS_KEY_ID,
    secretAccessKey: process.env.WIW_SECRET_ACCESS_KEY,
  };
}
const client = DynamoDBDocumentClient.from(new DynamoDBClient(clientConfig));

const dir = process.env.BACKUP_DIR;
if (!dir) { console.error('Set BACKUP_DIR (absolute path of a backup_tables.js snapshot).'); process.exit(1); }
const tables = process.argv.slice(2);
if (tables.length === 0) tables.push('wiw-registrations', 'wiw-dates');

(async () => {
  for (const t of tables) {
    const file = path.join(dir, t + '.json');
    const items = JSON.parse(fs.readFileSync(file, 'utf8'));
    console.log(`${t}: ${items.length} items to restore${DRY ? ' (DRY RUN)' : ''}`);
    if (DRY) continue;
    for (let i = 0; i < items.length; i += 25) {
      const batch = items.slice(i, i + 25);
      await client.send(new BatchWriteCommand({
        RequestItems: { [t]: batch.map(Item => ({ PutRequest: { Item } })) },
      }));
    }
    console.log(`${t}: restored ${items.length} items.`);
  }
  if (DRY) console.log('\nDRY RUN — no writes. Re-run without DRY_RUN=1 to restore.');
  else console.log('\nRestore complete.');
})().catch(e => { console.error(e); process.exit(1); });
