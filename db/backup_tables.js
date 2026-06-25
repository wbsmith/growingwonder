// Logical backup of DynamoDB tables to JSON, for fast rollback.
//
// Scans each table and writes every item to <BACKUP_DIR>/<table>.json. Pair with
// db/restore_tables.js to re-put the items if a migration goes wrong. Read-only
// against DynamoDB.
//
// Usage:
//   BACKUP_DIR="$HOME/wiw-backups/2026-06-24" node db/backup_tables.js
//   BACKUP_DIR=... node db/backup_tables.js wiw-registrations wiw-dates

const fs = require('fs');
const path = require('path');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand } = require('@aws-sdk/lib-dynamodb');

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
if (!dir) { console.error('Set BACKUP_DIR (absolute path).'); process.exit(1); }
const tables = process.argv.slice(2);
if (tables.length === 0) tables.push('wiw-registrations', 'wiw-dates');

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

(async () => {
  fs.mkdirSync(dir, { recursive: true });
  for (const t of tables) {
    const items = await scanAll(t);
    const file = path.join(dir, t + '.json');
    fs.writeFileSync(file, JSON.stringify(items, null, 2));
    console.log(`${t}: ${items.length} items -> ${file}`);
  }
  console.log('Backup complete:', dir);
})().catch(e => { console.error(e); process.exit(1); });
