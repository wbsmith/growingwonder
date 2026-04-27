// One-shot repair: undo the cross-program auto-merge that swallowed
// Ashley Weber's Adventure Days registration into her Nature Camps row.
//
// Effect:
//   - Re-creates the Adventure Days registration as its own row.
//   - Strips 2026-05-22 and the "Winter Webed" duplicate child from the
//     Nature Camps row (id 01KPW0H9WEQBW2PK7X54GB0XB2).
//   - Reassigns the Adventure Days confirmation email back to the new reg.
//
// Does NOT touch the wiw-dates capacity counter: enrolled=5 for
// Adventure Days 2026-05-22 is currently correct relative to 4 visible
// regs + 1 swallowed = 5, and stays correct after this restore.
//
// Run:  DRY_RUN=1 node db/repair_winter.js   (preview)
//       node db/repair_winter.js              (apply)

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, ScanCommand,
} = require('@aws-sdk/lib-dynamodb');
const { ulid } = require('ulid');

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

const CORRUPTED_REG_ID = '01KPW0H9WEQBW2PK7X54GB0XB2';
const ADVENTURE_DAYS_PROGRAM_ID = 'prog_01KP1R2NP9PE5MNE7CMX1H0CB1';
const ADVENTURE_DATE = '2026-05-22';
const TYPO_CHILD_NAME = 'Winter Webed';
const REAL_CHILD_NAME = 'Winter Weber';
const ORIGINAL_REG_CREATED_AT = '2026-04-25T03:19:55.395Z'; // from the AD email
const ADVENTURE_PAYMENT_AMOUNT = 115;
const ADVENTURE_PAYMENT_DATE = '2026-04-25';
const ADVENTURE_PAYMENT_NOTES = 'Venmo';

async function send(cmd, label) {
  if (DRY) { console.log(`[dry-run] ${label}`); return null; }
  return client.send(cmd);
}

(async () => {
  const { Item: reg } = await client.send(new GetCommand({
    TableName: 'wiw-registrations', Key: { id: CORRUPTED_REG_ID },
  }));
  if (!reg) { console.error('Corrupted reg not found — already repaired?'); process.exit(1); }

  // Sanity checks
  if (reg.programId === ADVENTURE_DAYS_PROGRAM_ID) {
    console.error('Reg is already Adventure Days — nothing to do.'); process.exit(1);
  }
  if (!(reg.selectedDates || []).includes(ADVENTURE_DATE)) {
    console.error(`Reg does not contain ${ADVENTURE_DATE} — already repaired?`); process.exit(1);
  }

  const realChild = (reg.children || []).find(c => c.name === REAL_CHILD_NAME);
  if (!realChild) { console.error(`Real child "${REAL_CHILD_NAME}" not found in reg.`); process.exit(1); }

  // 1. Create the restored Adventure Days registration.
  const newRegId = ulid();
  const newReg = {
    id: newRegId,
    programId: ADVENTURE_DAYS_PROGRAM_ID,
    parentName: reg.parentName,
    parentEmail: reg.parentEmail,
    parentPhone: reg.parentPhone,
    notes: null,
    children: [realChild],
    selectedDates: [ADVENTURE_DATE],
    paymentDate: ADVENTURE_PAYMENT_DATE,
    paymentAmount: ADVENTURE_PAYMENT_AMOUNT,
    paymentNotes: ADVENTURE_PAYMENT_NOTES,
    createdAt: ORIGINAL_REG_CREATED_AT,
  };
  console.log('New Adventure Days reg:', JSON.stringify(newReg, null, 2));
  await send(new PutCommand({ TableName: 'wiw-registrations', Item: newReg }), `Put new reg ${newRegId}`);

  // 2. Strip the Adventure Days date and the typo'd child from the Nature Camps reg.
  const newDates = (reg.selectedDates || []).filter(d => d !== ADVENTURE_DATE);
  const newChildren = (reg.children || []).filter(c => c.name !== TYPO_CHILD_NAME);
  console.log('Updated Nature Camps reg children:', newChildren.map(c => c.name).join(', '));
  console.log('Updated Nature Camps reg dates:', newDates.join(', '));
  await send(new UpdateCommand({
    TableName: 'wiw-registrations',
    Key: { id: CORRUPTED_REG_ID },
    UpdateExpression: 'SET selectedDates = :d, children = :c',
    ExpressionAttributeValues: { ':d': newDates, ':c': newChildren },
  }), `Update reg ${CORRUPTED_REG_ID}`);

  // 3. Re-link the Adventure Days confirmation email to the restored reg.
  const { Items: emails } = await client.send(new ScanCommand({
    TableName: 'wiw-email-queue',
    FilterExpression: 'toAddr = :e AND childName = :c AND programName = :p',
    ExpressionAttributeValues: {
      ':e': reg.parentEmail,
      ':c': TYPO_CHILD_NAME,
      ':p': 'Adventure Days',
    },
  }));
  if (!emails || emails.length === 0) {
    console.warn('No Adventure Days email found for relinking — skipping email step.');
  } else {
    for (const em of emails) {
      console.log(`Relinking email ${em.id} (${em.subject}) → reg ${newRegId}`);
      await send(new UpdateCommand({
        TableName: 'wiw-email-queue',
        Key: { id: em.id },
        UpdateExpression: 'SET registrationId = :r',
        ExpressionAttributeValues: { ':r': newRegId },
      }), `Relink email ${em.id}`);
    }
  }

  console.log(DRY ? '\nDRY RUN — no writes performed.' : '\nDone.');
})().catch(e => { console.error(e); process.exit(1); });
