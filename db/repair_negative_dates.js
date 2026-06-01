// One-shot repair: delete program dates whose `enrolled` counter went negative.
//
// Negative enrolled counts are physically impossible (you can't have a
// negative number of enrolled kids). They are an artifact of decrements
// firing without a matching increment — e.g., a test registration that was
// deleted twice, or a registration whose date was removed twice via the
// admin UI. The counter has since been guarded against further drift; this
// script cleans up the bad rows already in the table.
//
// Run:  DRY_RUN=1 node db/repair_negative_dates.js
//       node db/repair_negative_dates.js
//       PROGRAM_ID=prog_01KP1R2NNNGRYAF34DTQ7Z4BDJ node db/repair_negative_dates.js

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient, ScanCommand, DeleteCommand,
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

(async () => {
  const scanArgs = {
    TableName: 'wiw-dates',
    FilterExpression: 'enrolled < :zero',
    ExpressionAttributeValues: { ':zero': 0 },
  };
  if (PROGRAM_ID) {
    scanArgs.FilterExpression += ' AND programId = :pid';
    scanArgs.ExpressionAttributeValues[':pid'] = PROGRAM_ID;
  }

  let bad = [];
  let ExclusiveStartKey;
  do {
    const { Items, LastEvaluatedKey } = await client.send(new ScanCommand({
      ...scanArgs, ExclusiveStartKey,
    }));
    bad = bad.concat(Items || []);
    ExclusiveStartKey = LastEvaluatedKey;
  } while (ExclusiveStartKey);

  if (bad.length === 0) {
    console.log('No dates with negative enrolled counts. Nothing to do.');
    return;
  }

  console.log(`Found ${bad.length} date(s) with negative enrolled counts:`);
  for (const d of bad.sort((a, b) => (a.programId + a.date).localeCompare(b.programId + b.date))) {
    console.log(`  ${d.programId}  ${d.date}  enrolled=${d.enrolled}  maxCapacity=${d.maxCapacity}`);
  }

  if (DRY) {
    console.log('\nDRY RUN — no deletions performed. Re-run without DRY_RUN=1 to apply.');
    return;
  }

  for (const d of bad) {
    await client.send(new DeleteCommand({
      TableName: 'wiw-dates',
      Key: { programId: d.programId, date: d.date },
    }));
    console.log(`Deleted ${d.programId} ${d.date}`);
  }
  console.log(`\nDone. Deleted ${bad.length} date(s).`);
})().catch(e => { console.error(e); process.exit(1); });
