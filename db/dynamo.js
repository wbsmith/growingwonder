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
  inquiries: 'wiw-inquiries',
  pages: 'wiw-pages',
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
    Item: {
      id, name, description: description || null,
      longDescription: null,
      heroImage: null,
      media: [],  // [{type:'image'|'video', url, key, caption}]
      createdAt: new Date().toISOString(),
    },
    ConditionExpression: 'attribute_not_exists(id)',
  }));
  return id;
}

async function updateProgramDescription(id, longDescription) {
  await client.send(new UpdateCommand({
    TableName: T.programs,
    Key: { id },
    UpdateExpression: 'SET longDescription = :ld',
    ExpressionAttributeValues: { ':ld': longDescription || null },
  }));
}

async function updateProgramHero(id, data) {
  const expr = [];
  const vals = {};
  if (data.heroImage !== undefined) { expr.push('heroImage = :hi'); vals[':hi'] = data.heroImage || null; }
  if (data.heroTitle !== undefined) { expr.push('heroTitle = :ht'); vals[':ht'] = data.heroTitle || null; }
  if (data.heroSubtitle !== undefined) { expr.push('heroSubtitle = :hs'); vals[':hs'] = data.heroSubtitle || null; }
  if (data.heroOverlay !== undefined) { expr.push('heroOverlay = :ho'); vals[':ho'] = data.heroOverlay || null; }
  if (expr.length === 0) return;
  await client.send(new UpdateCommand({
    TableName: T.programs,
    Key: { id },
    UpdateExpression: 'SET ' + expr.join(', '),
    ExpressionAttributeValues: vals,
  }));
}

async function addProgramMedia(id, mediaItem) {
  await client.send(new UpdateCommand({
    TableName: T.programs,
    Key: { id },
    UpdateExpression: 'SET media = list_append(if_not_exists(media, :empty), :item)',
    ExpressionAttributeValues: {
      ':empty': [],
      ':item': [mediaItem],
    },
  }));
}

async function removeProgramMedia(id, mediaIndex) {
  await client.send(new UpdateCommand({
    TableName: T.programs,
    Key: { id },
    UpdateExpression: `REMOVE media[${parseInt(mediaIndex, 10)}]`,
  }));
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

// ---- Inquiries ----

async function createInquiry(data) {
  const id = ulid();
  const item = {
    id,
    name: data.name || null,
    email: data.email || null,
    phone: data.phone || null,
    subject: data.subject,
    message: data.message,
    status: 'new',
    reply: null,
    repliedAt: null,
    createdAt: new Date().toISOString(),
  };
  await client.send(new PutCommand({ TableName: T.inquiries, Item: item }));
  return id;
}

async function getAllInquiries() {
  const { Items } = await client.send(new ScanCommand({ TableName: T.inquiries }));
  return (Items || []).sort((a, b) => {
    const statusOrder = { 'new': 0, replied: 1 };
    const sa = statusOrder[a.status] ?? 2;
    const sb = statusOrder[b.status] ?? 2;
    if (sa !== sb) return sa - sb;
    return b.createdAt.localeCompare(a.createdAt);
  });
}

async function getInquiry(id) {
  const { Item } = await client.send(new GetCommand({
    TableName: T.inquiries, Key: { id },
  }));
  return Item || null;
}

async function replyToInquiry(id, replyText) {
  await client.send(new UpdateCommand({
    TableName: T.inquiries,
    Key: { id },
    UpdateExpression: 'SET #st = :replied, reply = :reply, repliedAt = :now',
    ExpressionAttributeNames: { '#st': 'status' },
    ExpressionAttributeValues: {
      ':replied': 'replied',
      ':reply': replyText,
      ':now': new Date().toISOString(),
    },
  }));
}

async function countNewInquiries() {
  const { Count } = await client.send(new QueryCommand({
    TableName: T.inquiries,
    IndexName: 'status-index',
    KeyConditionExpression: '#st = :new',
    ExpressionAttributeNames: { '#st': 'status' },
    ExpressionAttributeValues: { ':new': 'new' },
    Select: 'COUNT',
  }));
  return Count || 0;
}

// ---- Bulk email helpers ----

async function getEmailsByDate(programId, date) {
  const regs = await getRegistrationsByProgram(programId);
  const emails = new Set();
  for (const r of regs) {
    if ((r.selectedDates || []).includes(date)) {
      emails.add(r.parentEmail);
    }
  }
  return Array.from(emails);
}

async function getEmailsByWeek(programId, weekStart) {
  const start = new Date(weekStart + 'T00:00:00');
  const weekDates = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    weekDates.push(d.toISOString().slice(0, 10));
  }
  const regs = await getRegistrationsByProgram(programId);
  const emails = new Set();
  for (const r of regs) {
    if ((r.selectedDates || []).some(d => weekDates.includes(d))) {
      emails.add(r.parentEmail);
    }
  }
  return Array.from(emails);
}

async function getAllEmails_addresses() {
  const { Items } = await client.send(new ScanCommand({
    TableName: T.registrations,
    ProjectionExpression: 'parentEmail',
  }));
  const emails = new Set();
  (Items || []).forEach(r => { if (r.parentEmail) emails.add(r.parentEmail); });
  return Array.from(emails);
}

// ---- Pages ----

async function getPage(slug) {
  const { Item } = await client.send(new GetCommand({
    TableName: T.pages, Key: { slug },
  }));
  return Item || null;
}

async function savePage(slug, data) {
  const existing = await getPage(slug);
  const item = { slug, ...existing, ...data, updatedAt: new Date().toISOString() };
  if (!existing) item.createdAt = new Date().toISOString();
  await client.send(new PutCommand({ TableName: T.pages, Item: item }));
}

module.exports = {
  getAllPrograms, getProgram, createProgram, deleteProgram,
  updateProgramDescription, updateProgramHero, addProgramMedia, removeProgramMedia,
  getDatesByProgram, addDates, removeDate,
  createRegistration, getEnrollments, getRegistrationsByProgram,
  countRegistrationsByProgram, updatePayment,
  getAllEmails, getEmail, updateEmailDraft, markEmailSent, markEmailFailed,
  countPendingEmails, getDashboardStats,
  createInquiry, getAllInquiries, getInquiry, replyToInquiry, countNewInquiries,
  getEmailsByDate, getEmailsByWeek, getAllEmails_addresses,
  getPage, savePage,
};
