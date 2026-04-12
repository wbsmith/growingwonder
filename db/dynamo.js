const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient, PutCommand, GetCommand, DeleteCommand,
  UpdateCommand, ScanCommand, QueryCommand, TransactWriteCommand,
  BatchWriteCommand,
} = require('@aws-sdk/lib-dynamodb');
const { ulid } = require('ulid');

const region = process.env.WIW_AWS_REGION || process.env.AWS_REGION || 'us-west-1';
const clientConfig = { region };
if (process.env.WIW_ACCESS_KEY_ID) {
  clientConfig.credentials = {
    accessKeyId: process.env.WIW_ACCESS_KEY_ID,
    secretAccessKey: process.env.WIW_SECRET_ACCESS_KEY,
  };
}
const client = DynamoDBDocumentClient.from(new DynamoDBClient(clientConfig));

const T = {
  programs: 'wiw-programs',
  dates: 'wiw-dates',
  registrations: 'wiw-registrations',
  emails: 'wiw-email-queue',
};

// ---- Programs ----

async function getAllPrograms() {
  const { Items } = await client.send(new ScanCommand({ TableName: T.programs }));
  return (Items || []).sort((a, b) => a.id.localeCompare(b.id));
}

async function getProgram(id) {
  const { Item } = await client.send(new GetCommand({
    TableName: T.programs, Key: { id },
  }));
  return Item || null;
}

async function createProgram(name, description) {
  const id = 'prog_' + ulid();
  await client.send(new PutCommand({
    TableName: T.programs,
    Item: { id, name, description: description || null, createdAt: new Date().toISOString() },
    ConditionExpression: 'attribute_not_exists(id)',
  }));
  return id;
}

async function deleteProgram(id) {
  await client.send(new DeleteCommand({ TableName: T.programs, Key: { id } }));
  // Also delete all dates for this program
  const dates = await getDatesByProgram(id);
  if (dates.length > 0) {
    const batches = [];
    for (let i = 0; i < dates.length; i += 25) {
      batches.push(dates.slice(i, i + 25));
    }
    for (const batch of batches) {
      await client.send(new BatchWriteCommand({
        RequestItems: {
          [T.dates]: batch.map(d => ({
            DeleteRequest: { Key: { programId: id, date: d.date } },
          })),
        },
      }));
    }
  }
}

// ---- Dates ----

async function getDatesByProgram(programId) {
  const { Items } = await client.send(new QueryCommand({
    TableName: T.dates,
    KeyConditionExpression: 'programId = :pid',
    ExpressionAttributeValues: { ':pid': programId },
  }));
  return (Items || []).sort((a, b) => a.date.localeCompare(b.date));
}

async function addDates(programId, dateList, maxCapacity) {
  const batches = [];
  for (let i = 0; i < dateList.length; i += 25) {
    batches.push(dateList.slice(i, i + 25));
  }
  for (const batch of batches) {
    await client.send(new BatchWriteCommand({
      RequestItems: {
        [T.dates]: batch.map(date => ({
          PutRequest: {
            Item: { programId, date, maxCapacity, enrolled: 0 },
          },
        })),
      },
    }));
  }
}

async function removeDate(programId, date) {
  // Check enrolled count first
  const { Item } = await client.send(new GetCommand({
    TableName: T.dates, Key: { programId, date },
  }));
  if (Item && Item.enrolled > 0) {
    return { ok: false, reason: 'Cannot remove a date with existing enrollments.' };
  }
  await client.send(new DeleteCommand({
    TableName: T.dates, Key: { programId, date },
  }));
  return { ok: true };
}

// ---- Registrations ----

async function createRegistration(data) {
  const id = ulid();
  const now = new Date().toISOString();
  const reg = {
    id,
    programId: data.programId,
    parentName: data.parentName,
    parentEmail: data.parentEmail,
    parentPhone: data.parentPhone,
    notes: data.notes || null,
    children: data.children, // [{name, dob, healthcareProvider, allergies}]
    selectedDates: data.selectedDates, // ["2026-06-15", ...]
    paymentDate: null,
    paymentAmount: null,
    paymentNotes: null,
    createdAt: now,
  };

  // Transactionally: write registration + increment enrolled on each date
  const transactItems = [
    { Put: { TableName: T.registrations, Item: reg } },
  ];
  for (const date of data.selectedDates) {
    transactItems.push({
      Update: {
        TableName: T.dates,
        Key: { programId: data.programId, date },
        UpdateExpression: 'ADD enrolled :one',
        ExpressionAttributeValues: { ':one': 1 },
      },
    });
  }

  // Also create the email queue entry
  const emailId = ulid();
  const emailItem = {
    id: emailId,
    registrationId: id,
    toAddr: data.parentEmail,
    subject: data.emailSubject,
    body: data.emailBody,
    status: 'draft',
    sentAt: null,
    createdAt: now,
    parentName: data.parentName,
    childName: data.children.map(c => c.name).join(', '),
    programName: data.programName,
  };
  transactItems.push({ Put: { TableName: T.emails, Item: emailItem } });

  await client.send(new TransactWriteCommand({ TransactItems: transactItems }));
  return id;
}

async function getEnrollments(programId) {
  let items;
  if (programId) {
    const { Items } = await client.send(new QueryCommand({
      TableName: T.registrations,
      IndexName: 'programId-index',
      KeyConditionExpression: 'programId = :pid',
      ExpressionAttributeValues: { ':pid': programId },
      ScanIndexForward: false,
    }));
    items = Items || [];
  } else {
    const { Items } = await client.send(new ScanCommand({ TableName: T.registrations }));
    items = (Items || []).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  // Attach program name
  const programs = await getAllPrograms();
  const progMap = Object.fromEntries(programs.map(p => [p.id, p.name]));
  return items.map(r => ({
    ...r,
    programName: progMap[r.programId] || 'Unknown',
  }));
}

async function getRegistrationsByProgram(programId) {
  const { Items } = await client.send(new QueryCommand({
    TableName: T.registrations,
    IndexName: 'programId-index',
    KeyConditionExpression: 'programId = :pid',
    ExpressionAttributeValues: { ':pid': programId },
    ScanIndexForward: false,
  }));
  return Items || [];
}

async function countRegistrationsByProgram(programId) {
  const { Count } = await client.send(new QueryCommand({
    TableName: T.registrations,
    IndexName: 'programId-index',
    KeyConditionExpression: 'programId = :pid',
    ExpressionAttributeValues: { ':pid': programId },
    Select: 'COUNT',
  }));
  return Count || 0;
}

async function updatePayment(id, paymentDate, paymentAmount, paymentNotes) {
  await client.send(new UpdateCommand({
    TableName: T.registrations,
    Key: { id },
    UpdateExpression: 'SET paymentDate = :pd, paymentAmount = :pa, paymentNotes = :pn',
    ExpressionAttributeValues: {
      ':pd': paymentDate || null,
      ':pa': paymentAmount != null ? paymentAmount : null,
      ':pn': paymentNotes || null,
    },
  }));
}

// ---- Email Queue ----

async function getAllEmails() {
  const { Items } = await client.send(new ScanCommand({ TableName: T.emails }));
  return (Items || []).sort((a, b) => {
    const statusOrder = { draft: 0, sent: 1, failed: 2 };
    const sa = statusOrder[a.status] ?? 3;
    const sb = statusOrder[b.status] ?? 3;
    if (sa !== sb) return sa - sb;
    return b.createdAt.localeCompare(a.createdAt);
  });
}

async function getEmail(id) {
  const { Item } = await client.send(new GetCommand({
    TableName: T.emails, Key: { id },
  }));
  return Item || null;
}

async function updateEmailDraft(id, subject, body) {
  await client.send(new UpdateCommand({
    TableName: T.emails,
    Key: { id },
    UpdateExpression: 'SET subject = :s, body = :b',
    ConditionExpression: '#st = :draft',
    ExpressionAttributeNames: { '#st': 'status' },
    ExpressionAttributeValues: { ':s': subject, ':b': body, ':draft': 'draft' },
  }));
}

async function markEmailSent(id) {
  await client.send(new UpdateCommand({
    TableName: T.emails,
    Key: { id },
    UpdateExpression: 'SET #st = :sent, sentAt = :now',
    ExpressionAttributeNames: { '#st': 'status' },
    ExpressionAttributeValues: { ':sent': 'sent', ':now': new Date().toISOString() },
  }));
}

async function markEmailFailed(id) {
  await client.send(new UpdateCommand({
    TableName: T.emails,
    Key: { id },
    UpdateExpression: 'SET #st = :failed',
    ExpressionAttributeNames: { '#st': 'status' },
    ExpressionAttributeValues: { ':failed': 'failed' },
  }));
}

async function countPendingEmails() {
  const { Count } = await client.send(new QueryCommand({
    TableName: T.emails,
    IndexName: 'status-index',
    KeyConditionExpression: '#st = :draft',
    ExpressionAttributeNames: { '#st': 'status' },
    ExpressionAttributeValues: { ':draft': 'draft' },
    Select: 'COUNT',
  }));
  return Count || 0;
}

// ---- Stats ----

async function getDashboardStats() {
  const programs = await getAllPrograms();
  const stats = [];
  for (const p of programs) {
    const count = await countRegistrationsByProgram(p.id);
    stats.push({ id: p.id, name: p.name, total_registrations: count });
  }
  return stats;
}

module.exports = {
  getAllPrograms, getProgram, createProgram, deleteProgram,
  getDatesByProgram, addDates, removeDate,
  createRegistration, getEnrollments, getRegistrationsByProgram,
  countRegistrationsByProgram, updatePayment,
  getAllEmails, getEmail, updateEmailDraft, markEmailSent, markEmailFailed,
  countPendingEmails, getDashboardStats,
};
