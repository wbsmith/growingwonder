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

// Single source of truth for a date's capacity when the item somehow lacks one
// (older rows, partial writes). Both the public capacity pre-check and the
// atomic registration guard use this so they can never disagree on a default.
const DEFAULT_DATE_CAPACITY = 12;

// ---- Programs ----

async function getAllPrograms() {
  const { Items } = await client.send(new ScanCommand({ TableName: T.programs }));
  const programs = (Items || []).sort((a, b) => a.id.localeCompare(b.id));
  // Backfill slugs for programs created before slug support
  for (const p of programs) {
    if (!p.slug) {
      p.slug = slugify(p.name);
      await client.send(new UpdateCommand({
        TableName: T.programs,
        Key: { id: p.id },
        UpdateExpression: 'SET slug = :s',
        ExpressionAttributeValues: { ':s': p.slug },
      }));
    }
  }
  return programs;
}

async function getProgramBySlug(slug) {
  const programs = await getAllPrograms();
  return programs.find(p => p.slug === slug) || null;
}

async function getProgram(id) {
  const { Item } = await client.send(new GetCommand({
    TableName: T.programs, Key: { id },
  }));
  return Item || null;
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function createProgram(name, description) {
  const id = 'prog_' + ulid();
  await client.send(new PutCommand({
    TableName: T.programs,
    Item: {
      id, name, slug: slugify(name), description: description || null,
      longDescription: null,
      heroImage: null,
      media: [],
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

async function updateProgramRegDescription(id, registrationDescription) {
  await client.send(new UpdateCommand({
    TableName: T.programs,
    Key: { id },
    UpdateExpression: 'SET registrationDescription = :rd',
    ExpressionAttributeValues: { ':rd': registrationDescription || null },
  }));
}

// Merges a stored field spec with a default, allowing partial overrides.
// Used by materializeFormConfig.
function _mergeField(stored, defaults) {
  const src = stored || {};
  const label = (src.label === undefined || src.label === null || src.label === '') ? defaults.label : src.label;
  return {
    show: src.show !== undefined ? !!src.show : defaults.show,
    required: src.required !== undefined ? !!src.required : defaults.required,
    label,
  };
}

// Returns a fully-populated form config for the public registration form,
// merging the program's stored formConfig with any legacy flat fields and
// the defaults. Pure read-side; does not mutate or persist.
function materializeFormConfig(program) {
  if (!program) return null;
  const cfg = program.formConfig || {};
  const parts = cfg.participants || {};
  const partsFields = parts.fields || {};
  return {
    pageTitlePrefix: (cfg.pageTitlePrefix && cfg.pageTitlePrefix.trim()) || 'Registration',
    pageLead: (cfg.pageLead && cfg.pageLead.trim()) || null,
    programSelector: {
      show: cfg.programSelector && cfg.programSelector.show !== undefined
        ? !!cfg.programSelector.show
        : (program.showProgramSelector === undefined ? true : !!program.showProgramSelector),
    },
    contactName:  _mergeField(cfg.contactName,  { show: true, required: true, label: program.contactHeading || 'Parent/Guardian Name' }),
    contactEmail: _mergeField(cfg.contactEmail, { show: true, required: true, label: program.emailLabel || 'Email' }),
    contactPhone: _mergeField(cfg.contactPhone, { show: true, required: true, label: program.phoneLabel || 'Phone' }),
    participants: {
      sectionHeading: parts.sectionHeading || program.participantsHeading || 'Children',
      singularLabel: parts.singularLabel || program.participantSingularLabel || 'Child',
      singleOnly: parts.singleOnly !== undefined ? !!parts.singleOnly : !!program.singleParticipantOnly,
      fields: {
        name:       _mergeField(partsFields.name,       { show: true, required: true, label: null }),
        dob:        _mergeField(partsFields.dob,        { show: true, required: true, label: program.dobLabel || 'Date of Birth' }),
        healthcare: _mergeField(partsFields.healthcare, { show: true, required: false, label: program.healthcareLabel || 'Healthcare Provider' }),
        allergies:  _mergeField(partsFields.allergies,  { show: true, required: false, label: program.allergiesLabel || 'Allergies' }),
      },
    },
    notes: _mergeField(cfg.notes, { show: true, required: false, label: program.notesPrompt || 'Tell us a little something about your child' }),
    terms: _mergeField(cfg.terms, { show: true, required: true, label: null }),
  };
}

async function updateProgramFormConfig(id, formConfig) {
  await client.send(new UpdateCommand({
    TableName: T.programs,
    Key: { id },
    UpdateExpression: 'SET formConfig = :c',
    ExpressionAttributeValues: { ':c': formConfig || null },
  }));
}

async function updateProgramCustomQuestions(id, questions) {
  // questions: [{label, helpText, type, required}]
  const sanitized = (questions || [])
    .filter(q => q && q.label && q.label.trim())
    .map(q => ({
      label: String(q.label).trim(),
      helpText: q.helpText ? String(q.helpText).trim() : null,
      type: q.type === 'textarea' ? 'textarea' : 'text',
      required: !!q.required,
    }));
  await client.send(new UpdateCommand({
    TableName: T.programs,
    Key: { id },
    UpdateExpression: 'SET customQuestions = :q',
    ExpressionAttributeValues: { ':q': sanitized },
  }));
}

async function updateProgramFormLabels(id, labels) {
  await client.send(new UpdateCommand({
    TableName: T.programs,
    Key: { id },
    UpdateExpression: 'SET participantsHeading = :ph, participantSingularLabel = :psl, contactHeading = :ch, notesPrompt = :np, singleParticipantOnly = :spo, emailLabel = :el, phoneLabel = :pl, dobLabel = :dl, healthcareLabel = :hl, allergiesLabel = :al, showProgramSelector = :sps',
    ExpressionAttributeValues: {
      ':ph': labels.participantsHeading || null,
      ':psl': labels.participantSingularLabel || null,
      ':ch': labels.contactHeading || null,
      ':np': labels.notesPrompt || null,
      ':spo': !!labels.singleParticipantOnly,
      ':el': labels.emailLabel || null,
      ':pl': labels.phoneLabel || null,
      ':dl': labels.dobLabel || null,
      ':hl': labels.healthcareLabel || null,
      ':al': labels.allergiesLabel || null,
      // Default true when undefined so existing programs keep their selector visible.
      ':sps': labels.showProgramSelector === undefined ? true : !!labels.showProgramSelector,
    },
  }));
}

async function updateProgramHero(id, data) {
  const expr = [];
  const vals = {};
  if (data.heroImage !== undefined) { expr.push('heroImage = :hi'); vals[':hi'] = data.heroImage || null; }
  if (data.heroTitle !== undefined) { expr.push('heroTitle = :ht'); vals[':ht'] = data.heroTitle || null; }
  if (data.heroSubtitle !== undefined) { expr.push('heroSubtitle = :hs'); vals[':hs'] = data.heroSubtitle || null; }
  if (data.heroOverlay !== undefined) { expr.push('heroOverlay = :ho'); vals[':ho'] = data.heroOverlay || null; }
  if (data.heroPosition !== undefined) { expr.push('heroPosition = :hp'); vals[':hp'] = data.heroPosition || null; }
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

async function updateDateCapacity(programId, date, maxCapacity) {
  await client.send(new UpdateCommand({
    TableName: T.dates,
    Key: { programId, date },
    UpdateExpression: 'SET maxCapacity = :cap',
    ExpressionAttributeValues: { ':cap': maxCapacity },
  }));
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

// Dates live on each child (`child.dates`). The registration-level
// `selectedDates` is the derived union of every child's dates and is kept in
// sync on every write — many readers (CSV, email targeting, merge, displays)
// rely on it for family-level "did anyone attend day X" semantics.
function deriveSelectedDates(children) {
  const s = new Set();
  for (const c of (children || [])) for (const d of (c.dates || [])) s.add(d);
  return Array.from(s).sort();
}

// Map of date -> number of children attending it (capacity is heads, not
// families). Children predating per-child dates fall back to `fallbackDates`.
// A registration with no participant rows (e.g. CIT applicant in custom
// responses) counts as one participant on each of its dates.
function headCountsByDate(children, fallbackDates) {
  const m = new Map();
  const kids = children || [];
  if (kids.length === 0) {
    for (const d of (fallbackDates || [])) m.set(d, (m.get(d) || 0) + 1);
    return m;
  }
  for (const c of kids) {
    const dates = Array.isArray(c.dates) ? c.dates : (fallbackDates || []);
    for (const d of dates) m.set(d, (m.get(d) || 0) + 1);
  }
  return m;
}

async function createRegistration(data) {
  const id = ulid();
  const now = new Date().toISOString();

  // Each child carries its own dates. Older callers pass a single family-wide
  // `selectedDates` and dateless children — normalize so every child gets the
  // family dates, then derive the registration-level union from the children.
  const children = (data.children || []).map(c => ({
    ...c,
    dates: Array.isArray(c.dates) ? c.dates : (data.selectedDates || []),
  }));
  const selectedDates = deriveSelectedDates(children);

  const reg = {
    id,
    programId: data.programId,
    parentName: data.parentName,
    parentEmail: data.parentEmail,
    parentPhone: data.parentPhone,
    notes: data.notes || null,
    customResponses: data.customResponses || [],
    children, // [{name, dob, healthcareProvider, allergies, dates}]
    selectedDates, // derived union of all children's dates
    paymentDate: null,
    paymentAmount: null,
    paymentNotes: null,
    createdAt: now,
  };

  // Transactionally: write registration + increment each date's enrolled by the
  // number of CHILDREN attending that date (capacity is heads, not families).
  const transactItems = [
    { Put: { TableName: T.registrations, Item: reg } },
  ];
  if (data.programId && data.programId !== 'imported') {
    // Condition expressions can't do arithmetic (that's update-expression-only),
    // so `enrolled + heads <= maxCapacity` is invalid and throws ValidationException.
    // Precompute each date's ceiling (maxCapacity - heads) and compare `enrolled <= :ceil`.
    const dateItems = await getDatesByProgram(data.programId);
    const capByDate = {};
    dateItems.forEach(d => { capByDate[d.date] = d.maxCapacity; });
    for (const date of selectedDates) {
      const heads = children.filter(c => (c.dates || []).includes(date)).length;
      const update = {
        TableName: T.dates,
        Key: { programId: data.programId, date },
        UpdateExpression: 'ADD enrolled :n',
        ExpressionAttributeValues: { ':n': heads },
      };
      const cap = typeof capByDate[date] === 'number' ? capByDate[date] : DEFAULT_DATE_CAPACITY;
      update.ConditionExpression = 'attribute_not_exists(enrolled) OR enrolled <= :ceil';
      update.ExpressionAttributeValues[':ceil'] = cap - heads;
      transactItems.push({ Update: update });
    }
  }

  // Create email queue entry only if there's a subject (skip for imports)
  if (data.emailSubject && data.parentEmail) {
    const emailId = ulid();
    const emailItem = {
      id: emailId,
      registrationId: id,
      direction: 'out',
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
  }

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

async function getRegistration(id) {
  const { Item } = await client.send(new GetCommand({
    TableName: T.registrations, Key: { id },
  }));
  return Item || null;
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

async function deleteRegistration(id) {
  // Get the registration to find dates to decrement
  const reg = await client.send(new GetCommand({
    TableName: T.registrations, Key: { id },
  }));
  if (!reg.Item) return;

  const item = reg.Item;

  // Decrement enrolled on each date by the number of children that attended it
  // — guarded so the counter never goes below zero.
  if (item.programId && item.programId !== 'imported') {
    const heads = headCountsByDate(item.children, item.selectedDates);
    for (const [date, n] of heads) {
      try {
        await client.send(new UpdateCommand({
          TableName: T.dates,
          Key: { programId: item.programId, date },
          UpdateExpression: 'ADD enrolled :neg',
          ConditionExpression: 'attribute_exists(enrolled) AND enrolled >= :n',
          ExpressionAttributeValues: { ':neg': -n, ':n': n },
        }));
      } catch (e) { /* date missing or would go negative — skip */ }
    }
  }

  // Delete associated email queue entries
  const { Items: emails } = await client.send(new ScanCommand({
    TableName: T.emails,
    FilterExpression: 'registrationId = :rid',
    ExpressionAttributeValues: { ':rid': id },
  }));
  if (emails && emails.length > 0) {
    for (const em of emails) {
      await client.send(new DeleteCommand({ TableName: T.emails, Key: { id: em.id } }));
    }
  }

  // Delete the registration
  await client.send(new DeleteCommand({ TableName: T.registrations, Key: { id } }));
}

async function mergeRegistrations(ids) {
  // Fetch all registrations
  const regs = [];
  for (const id of ids) {
    const { Item } = await client.send(new GetCommand({ TableName: T.registrations, Key: { id } }));
    if (Item) regs.push(Item);
  }
  if (regs.length < 2) throw new Error('Not enough valid registrations to merge.');

  // Refuse cross-program merges — a registration is intrinsically per-program.
  const programIds = new Set(regs.map(r => r.programId));
  if (programIds.size > 1) {
    throw new Error('Cannot merge registrations from different programs.');
  }

  // Sort by createdAt — keep the earliest as the primary
  regs.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  const primary = regs[0];
  const others = regs.slice(1);

  // Merge children (dedup by name+dob), unioning each child's dates. A child
  // predating per-child dates inherits its registration's family dates.
  const childKey = (c) => (c.name || '') + '|' + (c.dob || '');
  const childMap = new Map();
  const addChild = (c, fallbackDates) => {
    const key = childKey(c);
    const dates = Array.isArray(c.dates) ? c.dates : (fallbackDates || []);
    if (!childMap.has(key)) {
      childMap.set(key, { ...c, dates: [...dates] });
    } else {
      const existing = childMap.get(key);
      existing.dates = Array.from(new Set([...(existing.dates || []), ...dates])).sort();
    }
  };
  for (const c of (primary.children || [])) addChild(c, primary.selectedDates);
  for (const r of others) {
    for (const c of (r.children || [])) addChild(c, r.selectedDates);
  }
  const mergedChildren = Array.from(childMap.values());
  const allDates = new Set(deriveSelectedDates(mergedChildren));

  // Merge notes
  const allNotes = [primary.notes, ...others.map(r => r.notes)].filter(Boolean);
  const mergedNotes = [...new Set(allNotes)].join('; ') || null;

  // Update primary with merged data
  await client.send(new UpdateCommand({
    TableName: T.registrations,
    Key: { id: primary.id },
    UpdateExpression: 'SET selectedDates = :dates, children = :children, notes = :notes',
    ExpressionAttributeValues: {
      ':dates': Array.from(allDates).sort(),
      ':children': mergedChildren,
      ':notes': mergedNotes,
    },
  }));

  // Merge email queue: keep the primary's draft, reassign others, merge draft bodies
  const allRegIds = regs.map(r => r.id);
  const { Items: allEmails } = await client.send(new ScanCommand({
    TableName: T.emails,
    FilterExpression: allRegIds.map((_, i) => 'registrationId = :rid' + i).join(' OR '),
    ExpressionAttributeValues: Object.fromEntries(allRegIds.map((rid, i) => [':rid' + i, rid])),
  }));

  if (allEmails && allEmails.length > 0) {
    // Find draft emails to merge into one combined draft
    const drafts = allEmails.filter(e => e.status === 'draft');
    const sent = allEmails.filter(e => e.status !== 'draft');

    if (drafts.length > 1) {
      // Keep the first draft, merge the dates into its body, delete the rest
      const keepDraft = drafts[0];
      const mergedDates = Array.from(allDates).sort().map(d => {
        const dt = new Date(d + 'T00:00:00');
        return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      }).join('\n  ');
      const childNames = Array.from(childMap.values()).map(c => c.name);
      const childListStr = childNames.length === 1 ? childNames[0]
        : childNames.slice(0, -1).join(', ') + ' and ' + childNames[childNames.length - 1];

      // Recompose the body with merged dates
      const site = require('../lib/site');
      const newBody = `Dear ${primary.parentName},\n\nThank you for registering ${childListStr} for ${keepDraft.programName || 'our program'}!\n\nEnrolled dates:\n  ${mergedDates}\n\nWe're excited to have ${childListStr} join us. Please arrive by 8:45 AM on the first day. Don't forget sunscreen, a water bottle, and a sense of adventure!\n\nIf you have any questions, reply to this email or call us at ${site.phone}.\n\nWarm regards,\n${site.name} Team`;

      await client.send(new UpdateCommand({
        TableName: T.emails,
        Key: { id: keepDraft.id },
        UpdateExpression: 'SET registrationId = :rid, body = :body, childName = :cn',
        ExpressionAttributeValues: {
          ':rid': primary.id,
          ':body': newBody,
          ':cn': childNames.join(', '),
        },
      }));

      // Delete other drafts
      for (let i = 1; i < drafts.length; i++) {
        await client.send(new DeleteCommand({ TableName: T.emails, Key: { id: drafts[i].id } }));
      }
    } else if (drafts.length === 1) {
      // Just reassign the single draft
      await client.send(new UpdateCommand({
        TableName: T.emails,
        Key: { id: drafts[0].id },
        UpdateExpression: 'SET registrationId = :rid',
        ExpressionAttributeValues: { ':rid': primary.id },
      }));
    }

    // Reassign sent emails to primary
    for (const em of sent) {
      await client.send(new UpdateCommand({
        TableName: T.emails,
        Key: { id: em.id },
        UpdateExpression: 'SET registrationId = :rid',
        ExpressionAttributeValues: { ':rid': primary.id },
      }));
    }
  }

  // Delete the other registrations
  for (const r of others) {
    await client.send(new DeleteCommand({ TableName: T.registrations, Key: { id: r.id } }));
  }
}

async function autoMergeRegistrations(field) {
  // Fetch all registrations
  const { Items } = await client.send(new ScanCommand({ TableName: T.registrations }));
  if (!Items || Items.length < 2) return 0;

  // Group by field, scoped to programId so duplicates only merge within the same program.
  const groups = {};
  for (const r of Items) {
    if (!r.programId) continue;
    let keys = [];
    if (field === 'email' || field === 'both') {
      if (r.parentEmail) keys.push('email:' + r.parentEmail.toLowerCase() + '|prog:' + r.programId);
    }
    if (field === 'phone' || field === 'both') {
      if (r.parentPhone) {
        const digits = r.parentPhone.replace(/\D/g, '');
        if (digits) keys.push('phone:' + digits + '|prog:' + r.programId);
      }
    }
    for (const key of keys) {
      if (!groups[key]) groups[key] = [];
      // Avoid adding the same registration twice (when matching on 'both')
      if (!groups[key].some(g => g.id === r.id)) {
        groups[key].push(r);
      }
    }
  }

  // For 'both' mode, merge groups that share any registration
  // (e.g., if reg A matches by email with B, and B matches by phone with C, merge all three)
  if (field === 'both') {
    const regToGroup = new Map(); // reg.id -> group key
    const mergedGroups = new Map(); // canonical key -> Set of reg ids

    for (const [key, regs] of Object.entries(groups)) {
      if (regs.length < 2) continue;
      // Find if any reg is already in a group
      let existingKey = null;
      for (const r of regs) {
        if (regToGroup.has(r.id)) { existingKey = regToGroup.get(r.id); break; }
      }
      const groupKey = existingKey || key;
      if (!mergedGroups.has(groupKey)) mergedGroups.set(groupKey, new Set());
      for (const r of regs) {
        mergedGroups.get(groupKey).add(r.id);
        regToGroup.set(r.id, groupKey);
      }
    }

    // Build final groups
    const finalGroups = {};
    for (const [key, ids] of mergedGroups.entries()) {
      if (ids.size >= 2) {
        finalGroups[key] = Items.filter(r => ids.has(r.id));
      }
    }
    let count = 0;
    for (const regs of Object.values(finalGroups)) {
      await mergeRegistrations(regs.map(r => r.id));
      count++;
    }
    return count;
  }

  // Simple mode: merge each group with 2+ registrations
  let count = 0;
  const merged = new Set();
  for (const regs of Object.values(groups)) {
    if (regs.length < 2) continue;
    // Skip if any reg was already merged in a previous group
    const ids = regs.map(r => r.id).filter(id => !merged.has(id));
    if (ids.length < 2) continue;
    await mergeRegistrations(ids);
    ids.forEach(id => merged.add(id));
    count++;
  }
  return count;
}

// Replace each child's date set (per-child editing). `childDates` is index-
// aligned to the registration's `children`: childDates[i] is child i's new full
// set of dates (replace semantics). Adjusts each date's head counter by the
// delta and returns any dates pushed over capacity (admin edits may exceed it).
async function updateRegistrationDates(id, childDates) {
  const { Item } = await client.send(new GetCommand({
    TableName: T.registrations, Key: { id },
  }));
  if (!Item) return { ok: false, error: 'Registration not found.' };

  const isImported = !Item.programId || Item.programId === 'imported';
  const oldChildren = Item.children || [];

  // Per-child editing needs participant rows. Refuse the rare child-less
  // registration so we never wipe its family-level selectedDates.
  if (oldChildren.length === 0) {
    return { ok: false, error: 'This registration has no participants to edit.' };
  }

  // Restrict submissions to real program dates so we never create a counter
  // row for a nonexistent date; capture capacities for the over-capacity check.
  let validSet = null;
  const capByDate = {};
  if (!isImported) {
    const programDates = await getDatesByProgram(Item.programId);
    validSet = new Set(programDates.map(d => d.date));
    programDates.forEach(d => { capByDate[d.date] = { maxCapacity: d.maxCapacity, enrolled: d.enrolled || 0 }; });
  }

  const newChildren = oldChildren.map((c, i) => {
    let nd = Array.from(new Set(childDates[i] || []));
    if (validSet) nd = nd.filter(d => validSet.has(d));
    nd.sort();
    return { ...c, dates: nd };
  });

  const oldH = headCountsByDate(oldChildren, Item.selectedDates);
  const newH = headCountsByDate(newChildren, null);
  const newSelected = deriveSelectedDates(newChildren);

  // Persist the registration first — counters are a derived cache the migration
  // script can always rebuild from registrations.
  await client.send(new UpdateCommand({
    TableName: T.registrations,
    Key: { id },
    UpdateExpression: 'SET children = :c, selectedDates = :s',
    ExpressionAttributeValues: { ':c': newChildren, ':s': newSelected },
  }));

  const overCapacity = [];
  if (!isImported) {
    const dates = new Set([...oldH.keys(), ...newH.keys()]);
    for (const date of dates) {
      const delta = (newH.get(date) || 0) - (oldH.get(date) || 0);
      if (delta === 0) continue;
      if (delta > 0) {
        // Admin override: no capacity condition — surface a warning instead.
        await client.send(new UpdateCommand({
          TableName: T.dates,
          Key: { programId: Item.programId, date },
          UpdateExpression: 'ADD enrolled :d',
          ExpressionAttributeValues: { ':d': delta },
        }));
        const cap = capByDate[date];
        if (cap && cap.maxCapacity != null && (cap.enrolled + delta) > cap.maxCapacity) {
          overCapacity.push({ date, enrolled: cap.enrolled + delta, capacity: cap.maxCapacity });
        }
      } else {
        try {
          await client.send(new UpdateCommand({
            TableName: T.dates,
            Key: { programId: Item.programId, date },
            UpdateExpression: 'ADD enrolled :d',
            ConditionExpression: 'attribute_exists(enrolled) AND enrolled >= :abs',
            ExpressionAttributeValues: { ':d': delta, ':abs': -delta },
          }));
        } catch (e) { /* counter drift — reconciled by the recompute script */ }
      }
    }
  }

  return { ok: true, selectedDates: newSelected, overCapacity };
}

// Per-program registration counts for default-program selection. `active` =
// registrations with at least one attendance date >= today (a YYYY-MM-DD string).
async function getRegistrationCountsByProgram(today) {
  const counts = {};
  let ExclusiveStartKey;
  do {
    const { Items, LastEvaluatedKey } = await client.send(new ScanCommand({
      TableName: T.registrations, ExclusiveStartKey,
    }));
    for (const r of (Items || [])) {
      if (!r.programId) continue;
      const c = counts[r.programId] || (counts[r.programId] = { active: 0, total: 0 });
      c.total++;
      if ((r.selectedDates || []).some(d => d >= today)) c.active++;
    }
    ExclusiveStartKey = LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return counts;
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
  return (Items || []).filter(e => !e.deletedAt).sort((a, b) => {
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

async function addEmailAttachment(id, attachment) {
  await client.send(new UpdateCommand({
    TableName: T.emails,
    Key: { id },
    UpdateExpression: 'SET attachments = list_append(if_not_exists(attachments, :empty), :item)',
    ExpressionAttributeValues: { ':empty': [], ':item': [attachment] },
  }));
}

async function removeEmailAttachment(id, index) {
  await client.send(new UpdateCommand({
    TableName: T.emails,
    Key: { id },
    UpdateExpression: `REMOVE attachments[${parseInt(index, 10)}]`,
  }));
}

async function markEmailSent(id, messageId) {
  const names = { '#st': 'status' };
  const values = { ':sent': 'sent', ':now': new Date().toISOString() };
  let expr = 'SET #st = :sent, sentAt = :now, #dir = :out';
  names['#dir'] = 'direction';
  values[':out'] = 'out';
  if (messageId) { expr += ', messageId = :mid'; values[':mid'] = messageId; }
  await client.send(new UpdateCommand({
    TableName: T.emails,
    Key: { id },
    UpdateExpression: expr,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
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
    FilterExpression: 'attribute_not_exists(deletedAt)',
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
  return (Items || []).filter(i => !i.deletedAt).sort((a, b) => {
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

async function softDeleteMessage(type, id, adminUser) {
  const table = type === 'email' ? T.emails : T.inquiries;
  await client.send(new UpdateCommand({
    TableName: table,
    Key: { id },
    UpdateExpression: 'SET deletedAt = :ts, deletedBy = :who',
    ExpressionAttributeValues: {
      ':ts': new Date().toISOString(),
      ':who': adminUser || 'admin',
    },
  }));
}

async function countNewInquiries() {
  const { Count } = await client.send(new QueryCommand({
    TableName: T.inquiries,
    IndexName: 'status-index',
    KeyConditionExpression: '#st = :new',
    FilterExpression: 'attribute_not_exists(deletedAt)',
    ExpressionAttributeNames: { '#st': 'status' },
    ExpressionAttributeValues: { ':new': 'new' },
    Select: 'COUNT',
  }));
  return Count || 0;
}

async function getEmailsByRegistration(registrationId) {
  const { Items } = await client.send(new ScanCommand({
    TableName: T.emails,
    FilterExpression: 'registrationId = :rid AND attribute_not_exists(deletedAt)',
    ExpressionAttributeValues: { ':rid': registrationId },
  }));
  return (Items || []).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// ---- Inbound mail (IMAP mirror) ----
//
// Inbound and outbound messages share the wiw-email-queue table, distinguished
// by `direction` ('in' | 'out'; missing == 'out' for legacy rows). Inbound rows
// carry the source mailbox, IMAP uid/uidvalidity (for incremental sync), the
// RFC Message-ID / In-Reply-To (for threading), and a read flag.

async function createInboundEmail(item) {
  await client.send(new PutCommand({ TableName: T.emails, Item: item }));
  return item.id;
}

async function createOutboundEmail(item) {
  await client.send(new PutCommand({ TableName: T.emails, Item: item }));
  return item.id;
}

// Per-mailbox sync state derived from already-stored rows (no separate table):
// the highest IMAP uid seen for each uidvalidity, plus the set of Message-IDs
// already stored (belt-and-suspenders dedup). Mirrors the full-scan pattern of
// getAllEmails — fine for this table's size.
async function getInboundState(mailbox) {
  const { Items } = await client.send(new ScanCommand({
    TableName: T.emails,
    FilterExpression: '#dir = :in AND mailbox = :m AND attribute_not_exists(deletedAt)',
    ExpressionAttributeNames: { '#dir': 'direction' },
    ExpressionAttributeValues: { ':in': 'in', ':m': mailbox },
  }));
  const maxUidByValidity = {};
  const messageIds = new Set();
  for (const it of Items || []) {
    if (it.messageId) messageIds.add(it.messageId);
    if (typeof it.imapUid === 'number' && it.imapUidValidity != null) {
      const v = String(it.imapUidValidity);
      if (!maxUidByValidity[v] || it.imapUid > maxUidByValidity[v]) maxUidByValidity[v] = it.imapUid;
    }
  }
  return { maxUidByValidity, messageIds };
}

// All non-deleted messages exchanged with a given address (case-insensitive),
// where "the other party" is fromAddr for inbound and toAddr for outbound.
// Backs address-keyed threads that aren't tied to a registration.
async function getThreadByAddr(addr) {
  const target = (addr || '').toLowerCase();
  const all = await getAllEmails();
  return all
    .filter(e => {
      const counterparty = (e.direction === 'in' ? e.fromAddr : e.toAddr) || '';
      return counterparty.toLowerCase() === target;
    })
    .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
}

// Most recent registration linked to an outbound message addressed to `addr`.
// Used to attach an inbound reply to the right registration thread when the
// reply's In-Reply-To header can't be matched directly.
async function findRegistrationIdByEmail(addr) {
  const target = (addr || '').toLowerCase();
  const all = await getAllEmails();
  const match = all
    .filter(e => e.registrationId && (e.toAddr || '').toLowerCase() === target)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))[0];
  return match ? match.registrationId : null;
}

// Resolve the registration an outbound message belongs to from a reply's
// In-Reply-To / References Message-IDs (preferred, exact threading).
async function findRegistrationIdByMessageId(messageIds) {
  const wanted = (messageIds || []).filter(Boolean);
  if (wanted.length === 0) return null;
  const all = await getAllEmails();
  const match = all.find(e => e.messageId && wanted.includes(e.messageId) && e.registrationId);
  return match ? match.registrationId : null;
}

async function markEmailRead(id) {
  await client.send(new UpdateCommand({
    TableName: T.emails,
    Key: { id },
    UpdateExpression: 'SET #read = :true',
    ExpressionAttributeNames: { '#read': 'read' },
    ExpressionAttributeValues: { ':true': true },
  }));
}

async function countUnreadInbound() {
  const { Count } = await client.send(new ScanCommand({
    TableName: T.emails,
    FilterExpression: '#dir = :in AND #read = :false AND attribute_not_exists(deletedAt)',
    ExpressionAttributeNames: { '#dir': 'direction', '#read': 'read' },
    ExpressionAttributeValues: { ':in': 'in', ':false': false },
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
  getAllPrograms, getProgram, getProgramBySlug, createProgram, deleteProgram,
  updateProgramDescription, updateProgramRegDescription, updateProgramFormLabels, updateProgramFormConfig, updateProgramCustomQuestions, updateProgramHero, addProgramMedia, removeProgramMedia,
  materializeFormConfig,
  DEFAULT_DATE_CAPACITY,
  getDatesByProgram, addDates, updateDateCapacity, removeDate,
  createRegistration, getRegistration, getEnrollments, getRegistrationsByProgram,
  countRegistrationsByProgram, deleteRegistration, mergeRegistrations, autoMergeRegistrations, updateRegistrationDates, updatePayment,
  deriveSelectedDates, getRegistrationCountsByProgram,
  getAllEmails, getEmail, getEmailsByRegistration, updateEmailDraft, addEmailAttachment, removeEmailAttachment,
  markEmailSent, markEmailFailed,
  createInboundEmail, createOutboundEmail, getInboundState, getThreadByAddr, findRegistrationIdByEmail, findRegistrationIdByMessageId,
  markEmailRead, countUnreadInbound,
  countPendingEmails, getDashboardStats,
  createInquiry, getAllInquiries, getInquiry, replyToInquiry, countNewInquiries, softDeleteMessage,
  getEmailsByDate, getEmailsByWeek, getAllEmails_addresses,
  getPage, savePage,
};
