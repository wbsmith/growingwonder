const express = require('express');
const router = express.Router();
const db = require('../db/dynamo');
const { validateAdmin, requireAuth } = require('../lib/auth');
const { loginLimiter, csrfMiddleware } = require('../lib/security');
const mailer = require('../lib/mailer');
const smtp = require('../lib/smtp');
const mailConfig = require('../lib/mail-config');
const imapSync = require('../lib/imap-sync');
const storage = require('../lib/storage');
const { ulid } = require('ulid');

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Send a reply through the mailbox (SMTP) so it lands in the mailbox's Sent
// folder and threads for the recipient; falls back to SES if SMTP isn't set up.
// Records the sent message as an outbound row so it shows in the thread.
async function deliverReply({ to, account, subject, body, inReplyTo, references, registrationId, meta }) {
  let messageId = null;
  if (smtp.isConfigured()) {
    const r = await smtp.sendReply({
      accountKey: account, to, subject, text: body,
      inReplyTo: inReplyTo || undefined,
      references: references ? references.split(/\s+/).filter(Boolean) : [],
    });
    messageId = r.messageId;
  } else if (mailer.isConfigured()) {
    const r = await mailer.send(to, subject, body, 'registration', [], 'text', { inReplyTo, references });
    messageId = r && r.messageId;
  } else {
    throw new Error('No mail transport configured (set MAIL_* or SES_* env vars).');
  }
  const now = new Date().toISOString();
  await db.createOutboundEmail({
    id: ulid(),
    direction: 'out',
    registrationId: registrationId || null,
    toAddr: to,
    mailbox: account || 'registration',
    subject,
    body,
    status: 'sent',
    sentAt: now,
    createdAt: now,
    messageId,
    inReplyTo: inReplyTo || null,
    parentName: (meta && meta.parentName) || null,
    childName: (meta && meta.childName) || null,
    programName: (meta && meta.programName) || null,
  });
  return messageId;
}

router.use(csrfMiddleware);

router.get('/login', (req, res) => {
  res.render('admin/login');
});

router.post('/login', loginLimiter, (req, res) => {
  const result = validateAdmin(req.body.username, req.body.pw);
  if (result.ok) {
    req.session.isAdmin = true;
    return res.redirect('/admin');
  }
  req.session.flash = { type: 'error', msg: result.reason };
  res.redirect('/admin/login');
});

router.get('/logout', (req, res) => {
  req.session = null;
  res.redirect('/admin/login');
});

// ============ DASHBOARD ============

router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const stats = await db.getDashboardStats();
  const pendingEmails = await db.countPendingEmails();
  const newInquiries = await db.countNewInquiries();
  res.render('admin/dashboard', { stats, pendingEmails, newInquiries });
}));

// ============ PROGRAMS ============

router.get('/programs', requireAuth, asyncHandler(async (req, res) => {
  const programs = await db.getAllPrograms();
  // Attach counts
  for (const p of programs) {
    const dates = await db.getDatesByProgram(p.id);
    p.dateCount = dates.length;
    p.regCount = await db.countRegistrationsByProgram(p.id);
  }
  res.render('admin/programs', { programs });
}));

router.post('/programs/add', requireAuth, asyncHandler(async (req, res) => {
  const { name, description } = req.body;
  if (!name) {
    req.session.flash = { type: 'error', msg: 'Program name is required.' };
    return res.redirect('/admin/programs');
  }
  try {
    await db.createProgram(name, description);
    req.session.flash = { type: 'success', msg: `Program "${name}" created.` };
  } catch (err) {
    req.session.flash = { type: 'error', msg: 'Error creating program.' };
  }
  res.redirect('/admin/programs');
}));

router.post('/programs/remove', requireAuth, asyncHandler(async (req, res) => {
  const { program_id } = req.body;
  const count = await db.countRegistrationsByProgram(program_id);
  if (count > 0) {
    req.session.flash = { type: 'error', msg: `Cannot remove a program with ${count} registration(s).` };
  } else {
    const program = await db.getProgram(program_id);
    await db.deleteProgram(program_id);
    req.session.flash = { type: 'success', msg: `Program "${program?.name}" removed.` };
  }
  res.redirect('/admin/programs');
}));

// Site Pages
router.get('/pages', requireAuth, (req, res) => {
  res.render('admin/pages', {
    pages: [
      { slug: 'home', title: 'Home Page' },
      { slug: 'about', title: 'About Page' },
      { slug: 'waiver', title: 'Liability Waiver' },
    ]
  });
});

// Page editor
router.get('/pages/:slug/edit', requireAuth, asyncHandler(async (req, res) => {
  const page = await db.getPage(req.params.slug) || { slug: req.params.slug };
  res.render('admin/page_edit', { page });
}));

router.post('/pages/:slug/content', requireAuth, asyncHandler(async (req, res) => {
  await db.savePage(req.params.slug, { body: req.body.body || null });
  req.session.flash = { type: 'success', msg: 'Page content updated.' };
  res.redirect(303, '/admin/pages/' + req.params.slug + '/edit');
}));

router.post('/pages/:slug/hero', requireAuth, asyncHandler(async (req, res) => {
  const { url, hero_title, hero_subtitle, hero_overlay, hero_position } = req.body;
  const data = {};
  if (url !== undefined) data.heroImage = url;
  if (hero_title !== undefined) data.heroTitle = hero_title;
  if (hero_subtitle !== undefined) data.heroSubtitle = hero_subtitle;
  if (hero_overlay !== undefined) data.heroOverlay = hero_overlay;
  if (hero_position !== undefined) data.heroPosition = hero_position;
  await db.savePage(req.params.slug, data);
  req.session.flash = { type: 'success', msg: 'Hero updated.' };
  res.redirect(303, '/admin/pages/' + req.params.slug + '/edit');
}));

router.post('/pages/:slug/upload-url', requireAuth, asyncHandler(async (req, res) => {
  const { filename, contentType } = req.body;
  const result = await storage.getUploadUrl('pages-' + req.params.slug, filename, contentType);
  res.json(result);
}));

// Program content editor
router.get('/programs/:id/edit', requireAuth, asyncHandler(async (req, res) => {
  const program = await db.getProgram(req.params.id);
  if (!program) return res.status(404).send('Program not found');
  // Attach a materialized config so the admin form renders the current effective
  // values (whether they live in the new formConfig field or legacy flat fields).
  program.formConfig = db.materializeFormConfig(program);
  res.render('admin/program_edit', { program });
}));

router.post('/programs/:id/content', requireAuth, asyncHandler(async (req, res) => {
  await db.updateProgramDescription(req.params.id, req.body.long_description);
  req.session.flash = { type: 'success', msg: 'Content updated.' };
  res.redirect(303, '/admin/programs/' + req.params.id + '/edit');
}));

router.post('/programs/:id/reg-description', requireAuth, asyncHandler(async (req, res) => {
  await db.updateProgramRegDescription(req.params.id, req.body.registration_description);
  req.session.flash = { type: 'success', msg: 'Registration description updated.' };
  res.redirect(303, '/admin/programs/' + req.params.id + '/edit');
}));

router.post('/programs/:id/custom-questions', requireAuth, asyncHandler(async (req, res) => {
  // Form posts question_label[], question_help[], question_type[], question_required[] in parallel arrays.
  const labels = [].concat(req.body.question_label || []);
  const helps = [].concat(req.body.question_help || []);
  const types = [].concat(req.body.question_type || []);
  const requiredIdx = new Set([].concat(req.body.question_required_idx || []).map(String));
  const questions = labels.map((label, i) => ({
    label,
    helpText: helps[i] || null,
    type: types[i] === 'textarea' ? 'textarea' : 'text',
    required: requiredIdx.has(String(i)),
  }));
  await db.updateProgramCustomQuestions(req.params.id, questions);
  req.session.flash = { type: 'success', msg: 'Custom questions updated.' };
  res.redirect(303, '/admin/programs/' + req.params.id + '/edit');
}));

router.post('/programs/:id/form-config', requireAuth, asyncHandler(async (req, res) => {
  const b = req.body;
  const fieldFromBody = (key, defaultLabel) => ({
    show: b[`${key}_show`] === 'on',
    required: b[`${key}_required`] === 'on',
    label: (b[`${key}_label`] || '').trim() || defaultLabel,
  });
  const formConfig = {
    pageTitlePrefix: (b.page_title_prefix || '').trim() || 'Registration',
    pageLead: (b.page_lead || '').trim() || null,
    programSelector: { show: b.show_program_selector === 'on' },
    contactName:  fieldFromBody('contact_name',  'Parent/Guardian Name'),
    contactEmail: fieldFromBody('contact_email', 'Email'),
    contactPhone: fieldFromBody('contact_phone', 'Phone'),
    participants: {
      sectionHeading: (b.participants_heading || '').trim() || 'Children',
      singularLabel: (b.participant_singular_label || '').trim() || 'Child',
      singleOnly: b.single_participant_only === 'on',
      fields: {
        name:       { show: b.pname_show === 'on',       required: b.pname_required === 'on',       label: (b.pname_label || '').trim() || null },
        dob:        fieldFromBody('pdob',        'Date of Birth'),
        healthcare: fieldFromBody('phealthcare', 'Healthcare Provider'),
        allergies:  fieldFromBody('pallergies',  'Allergies'),
      },
    },
    notes: fieldFromBody('notes', 'Tell us a little something about your child'),
    terms: { show: b.terms_show === 'on', required: b.terms_required === 'on', label: null },
  };
  await db.updateProgramFormConfig(req.params.id, formConfig);
  req.session.flash = { type: 'success', msg: 'Registration form updated.' };
  res.redirect(303, '/admin/programs/' + req.params.id + '/edit');
}));

router.post('/programs/:id/upload-url', requireAuth, asyncHandler(async (req, res) => {
  const { filename, contentType } = req.body;
  const result = await storage.getUploadUrl(req.params.id, filename, contentType);
  res.json(result);
}));

router.post('/programs/:id/media', requireAuth, asyncHandler(async (req, res) => {
  const { type, url, key, caption } = req.body;
  await db.addProgramMedia(req.params.id, { type, url, key, caption: caption || null });
  req.session.flash = { type: 'success', msg: 'Media added.' };
  res.redirect(303, '/admin/programs/' + req.params.id + '/edit');
}));

router.post('/programs/:id/media/remove', requireAuth, asyncHandler(async (req, res) => {
  const { index, key } = req.body;
  if (key) { try { await storage.deleteFile(key); } catch (e) { console.error('S3 delete error:', e); } }
  await db.removeProgramMedia(req.params.id, index);
  req.session.flash = { type: 'success', msg: 'Media removed.' };
  res.redirect(303, '/admin/programs/' + req.params.id + '/edit');
}));

router.post('/programs/:id/hero', requireAuth, asyncHandler(async (req, res) => {
  const { url, hero_title, hero_subtitle, hero_overlay, hero_position } = req.body;
  const data = {};
  if (url !== undefined) data.heroImage = url;
  if (hero_title !== undefined) data.heroTitle = hero_title;
  if (hero_subtitle !== undefined) data.heroSubtitle = hero_subtitle;
  if (hero_overlay !== undefined) data.heroOverlay = hero_overlay;
  if (hero_position !== undefined) data.heroPosition = hero_position;
  await db.updateProgramHero(req.params.id, data);
  req.session.flash = { type: 'success', msg: 'Hero updated.' };
  res.redirect(303, '/admin/programs/' + req.params.id + '/edit');
}));

// Program dates
router.get('/programs/:id/dates', requireAuth, asyncHandler(async (req, res) => {
  const program = await db.getProgram(req.params.id);
  if (!program) return res.status(404).send('Program not found');
  const dates = await db.getDatesByProgram(req.params.id);
  const programs = await db.getAllPrograms();
  res.render('admin/dates', { programs, dates, selectedProgramId: req.params.id, program });
}));

router.post('/dates/add', requireAuth, asyncHandler(async (req, res) => {
  const { program_id, dates, max_capacity } = req.body;
  const cap = parseInt(max_capacity, 10) || 12;
  const dateList = dates.split(',').map(d => d.trim()).filter(Boolean);
  await db.addDates(program_id, dateList, cap);
  req.session.flash = { type: 'success', msg: `Added ${dateList.length} date(s).` };
  res.redirect('/admin/programs/' + program_id + '/dates');
}));

router.post('/dates/capacity', requireAuth, asyncHandler(async (req, res) => {
  const { program_id, date, max_capacity } = req.body;
  const cap = parseInt(max_capacity, 10);
  if (!cap || cap < 1) {
    req.session.flash = { type: 'error', msg: 'Capacity must be at least 1.' };
  } else {
    await db.updateDateCapacity(program_id, date, cap);
    req.session.flash = { type: 'success', msg: `Capacity for ${date} set to ${cap}.` };
  }
  res.redirect('/admin/programs/' + program_id + '/dates');
}));

router.post('/dates/remove', requireAuth, asyncHandler(async (req, res) => {
  const { program_id, date_to_remove } = req.body;
  const result = await db.removeDate(program_id, date_to_remove);
  req.session.flash = result.ok
    ? { type: 'success', msg: 'Date removed.' }
    : { type: 'error', msg: result.reason };
  res.redirect('/admin/programs/' + program_id + '/dates');
}));

// ============ ENROLLMENTS (tabbed: registrations / payments / rosters) ============

router.get('/enrollments', requireAuth, asyncHandler(async (req, res) => {
  const tab = req.query.tab || 'registrations';
  const programId = req.query.program || null;
  const programs = await db.getAllPrograms();
  const enrollments = await db.getEnrollments(programId);

  // For payments tab: attach confirmation dates
  if (tab === 'payments') {
    const emails = await db.getAllEmails();
    const sentByReg = {};
    emails.forEach(e => {
      if (e.status === 'sent' && e.registrationId) {
        if (!sentByReg[e.registrationId] || e.sentAt > sentByReg[e.registrationId]) {
          sentByReg[e.registrationId] = e.sentAt;
        }
      }
    });
    enrollments.forEach(r => { r.confirmationDate = sentByReg[r.id] || null; });
  }

  // For rosters tab: build weeks
  let weeks = [];
  if (tab === 'rosters' && programId) {
    const allDates = await db.getDatesByProgram(programId);
    const weekSet = new Map();
    for (const d of allDates) {
      const dt = new Date(d.date + 'T00:00:00');
      const dow = dt.getDay();
      const mon = new Date(dt);
      mon.setDate(mon.getDate() - ((dow + 6) % 7));
      const monStr = mon.toISOString().slice(0, 10);
      if (!weekSet.has(monStr)) {
        const fri = new Date(mon);
        fri.setDate(fri.getDate() + 4);
        weekSet.set(monStr, fri.toISOString().slice(0, 10));
      }
    }
    weeks = Array.from(weekSet.entries()).map(([monday, friday]) => ({ monday, friday }));
  }

  // For summary tab: build weekly calendar with counts
  let summaryWeeks = [];
  if (tab === 'summary' && programId) {
    const allDates = await db.getDatesByProgram(programId);
    const regs = await db.getRegistrationsByProgram(programId);
    const dateSet = new Set(allDates.map(d => d.date));
    const dateCapacity = {};
    allDates.forEach(d => { dateCapacity[d.date] = d.maxCapacity || 12; });

    // Group dates into weeks (Mon-based)
    const weekMap = new Map(); // mondayStr -> { dates: Set, hasWeekend: false }
    for (const d of allDates) {
      const dt = new Date(d.date + 'T00:00:00');
      const dow = dt.getDay();
      const mon = new Date(dt);
      mon.setDate(mon.getDate() - ((dow + 6) % 7));
      const monStr = mon.toISOString().slice(0, 10);
      if (!weekMap.has(monStr)) weekMap.set(monStr, { dates: new Set(), hasWeekend: false });
      weekMap.get(monStr).dates.add(d.date);
      if (dow === 0 || dow === 6) weekMap.get(monStr).hasWeekend = true;
    }

    // For each week, compute per-day counts
    for (const [monStr, weekInfo] of Array.from(weekMap.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
      const mon = new Date(monStr + 'T00:00:00');
      const sun = new Date(mon); sun.setDate(sun.getDate() + 6);
      const numDays = weekInfo.hasWeekend ? 7 : 5;

      // Build array of day columns
      const days = [];
      const startDow = weekInfo.hasWeekend ? 0 : 1; // Sun or Mon
      for (let i = 0; i < numDays; i++) {
        const dayDow = weekInfo.hasWeekend ? i : i + 1; // 0-6 or 1-5
        const dayDate = new Date(mon);
        dayDate.setDate(dayDate.getDate() + (dayDow - 1)); // mon is dow=1
        const dateStr = dayDate.toISOString().slice(0, 10);
        const isAvailable = dateSet.has(dateStr);

        // Count enrollments for this date
        let count = 0;
        const enrolledParents = new Set();
        if (isAvailable) {
          for (const r of regs) {
            if ((r.selectedDates || []).includes(dateStr)) {
              count += (r.children || []).length; // total person-count
              enrolledParents.add(r.id);
            }
          }
        }

        days.push({
          date: dateStr,
          dow: dayDow,
          dayName: new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short' }),
          dayNum: parseInt(dateStr.split('-')[2]),
          available: isAvailable,
          count,
          capacity: dateCapacity[dateStr] || 0,
          distinctFamilies: enrolledParents.size,
        });
      }

      // Week totals
      let totalPersons = 0, distinctFamiliesWeek = new Set();
      for (const r of regs) {
        const regDates = r.selectedDates || [];
        const hasDateThisWeek = days.some(d => d.available && regDates.includes(d.date));
        if (hasDateThisWeek) {
          distinctFamiliesWeek.add(r.id);
          // Count total person-days
          for (const d of days) {
            if (d.available && regDates.includes(d.date)) {
              totalPersons += (r.children || []).length;
            }
          }
        }
      }

      const fri = new Date(mon); fri.setDate(fri.getDate() + 4);
      summaryWeeks.push({
        monday: monStr,
        friday: fri.toISOString().slice(0, 10),
        sunday: sun.toISOString().slice(0, 10),
        hasWeekend: weekInfo.hasWeekend,
        days,
        totalPersons,
        distinctFamilies: distinctFamiliesWeek.size,
      });
    }
  }

  res.render('admin/enrollments', { tab, enrollments, programs, selectedProgramId: programId, weeks, summaryWeeks });
}));

router.post('/enrollments/merge', requireAuth, asyncHandler(async (req, res) => {
  const { merge_mode, merge_field } = req.body;
  let { merge_ids } = req.body;
  const redirectUrl = req.get('Referer') || '/admin/enrollments?tab=registrations';

  if (merge_mode === 'auto') {
    // Auto-merge: group all registrations by the selected field
    try {
      const count = await db.autoMergeRegistrations(merge_field || 'email');
      req.session.flash = { type: 'success', msg: count > 0 ? `Auto-merged ${count} group(s).` : 'No duplicates found to merge.' };
    } catch (err) {
      console.error('Auto-merge error:', err);
      req.session.flash = { type: 'error', msg: 'Auto-merge failed: ' + err.message };
    }
    return res.redirect(303, redirectUrl);
  }

  // Manual merge
  if (!merge_ids) {
    req.session.flash = { type: 'error', msg: 'No registrations selected.' };
    return res.redirect(303, redirectUrl);
  }
  if (typeof merge_ids === 'string') merge_ids = [merge_ids];
  if (merge_ids.length < 2) {
    req.session.flash = { type: 'error', msg: 'Select at least 2 registrations to merge.' };
    return res.redirect(303, redirectUrl);
  }

  try {
    await db.mergeRegistrations(merge_ids);
    req.session.flash = { type: 'success', msg: `Merged ${merge_ids.length} registrations.` };
  } catch (err) {
    console.error('Merge error:', err);
    req.session.flash = { type: 'error', msg: 'Merge failed: ' + err.message };
  }
  res.redirect(303, redirectUrl);
}));

router.post('/enrollments/remove-date', requireAuth, asyncHandler(async (req, res) => {
  const { registration_id, date } = req.body;
  await db.removeDateFromRegistration(registration_id, date);
  req.session.flash = { type: 'success', msg: `Removed ${date} from registration.` };
  res.redirect(303, req.get('Referer') || '/admin/enrollments?tab=registrations');
}));

router.post('/enrollments/delete', requireAuth, asyncHandler(async (req, res) => {
  const { registration_id } = req.body;
  await db.deleteRegistration(registration_id);
  req.session.flash = { type: 'success', msg: 'Registration deleted.' };
  res.redirect(303, req.get('Referer') || '/admin/enrollments?tab=registrations');
}));

router.post('/enrollments/payment', requireAuth, asyncHandler(async (req, res) => {
  const { registration_id, payment_date, payment_amount, payment_notes } = req.body;
  const amount = payment_amount !== '' ? parseFloat(payment_amount) : null;
  await db.updatePayment(registration_id, payment_date || null, amount, payment_notes || null);
  req.session.flash = { type: 'success', msg: 'Payment info updated.' };
  res.redirect(303, req.get('Referer') || '/admin/enrollments?tab=payments');
}));

router.get('/enrollments/csv', requireAuth, asyncHandler(async (req, res) => {
  const programId = req.query.program || null;
  const enrollments = await db.getEnrollments(programId);
  const emails = await db.getAllEmails();
  const sentByReg = {};
  emails.forEach(e => { if (e.status === 'sent' && e.registrationId) sentByReg[e.registrationId] = e.sentAt; });

  const header = 'Parent Name,Email,Phone,Children,DOBs,Program,Dates,Confirmation Date,Payment Date,Payment Amount,Notes';
  const csvRows = enrollments.map(r => {
    const childNames = (r.children || []).map(c => c.name).join('; ');
    const childDobs = (r.children || []).map(c => c.dob).join('; ');
    const dates = (r.selectedDates || []).sort().join('; ');
    return [csvEsc(r.parentName), csvEsc(r.parentEmail), csvEsc(r.parentPhone), csvEsc(childNames), csvEsc(childDobs),
      csvEsc(r.programName), csvEsc(dates), csvEsc(sentByReg[r.id] || ''), csvEsc(r.paymentDate || ''),
      r.paymentAmount != null ? r.paymentAmount.toFixed(2) : '', csvEsc(r.paymentNotes || '')].join(',');
  });
  const filename = programId ? `status-${programId}-${new Date().toISOString().slice(0,10)}.csv` : `status-all-${new Date().toISOString().slice(0,10)}.csv`;
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(header + '\n' + csvRows.join('\n'));
}));

// Import
router.post('/enrollments/import', requireAuth, express.raw({ type: 'multipart/form-data', limit: '2mb' }), asyncHandler(async (req, res) => {
  // Parse multipart form to get the CSV content
  const contentType = req.headers['content-type'] || '';
  const boundaryMatch = contentType.match(/boundary=(.+)/);
  if (!boundaryMatch) {
    req.session.flash = { type: 'error', msg: 'Invalid upload.' };
    return res.redirect(303, '/admin/enrollments?tab=import');
  }
  const body = req.body.toString('utf8');
  const parts = body.split('--' + boundaryMatch[1]);
  let csvContent = '';
  for (const part of parts) {
    if (part.includes('filename=') && part.includes('.csv')) {
      const headerEnd = part.indexOf('\r\n\r\n');
      if (headerEnd !== -1) csvContent = part.slice(headerEnd + 4).trim();
      // Remove trailing boundary markers
      if (csvContent.endsWith('--')) csvContent = csvContent.slice(0, -2).trim();
    }
  }

  if (!csvContent) {
    req.session.flash = { type: 'error', msg: 'No CSV data found.' };
    return res.redirect(303, '/admin/enrollments?tab=import');
  }

  const lines = csvContent.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) {
    req.session.flash = { type: 'error', msg: 'CSV must have a header row and at least one data row.' };
    return res.redirect(303, '/admin/enrollments?tab=import');
  }

  // Parse header
  const header = lines[0].toLowerCase().split(',').map(h => h.trim().replace(/"/g, ''));
  const colIdx = (name) => header.findIndex(h => h.includes(name));
  const iName = colIdx('parent');
  const iEmail = colIdx('email');
  const iPhone = colIdx('phone');
  const iChild = colIdx('child');
  const iDob = colIdx('dob');
  const iAllergy = colIdx('allerg');
  const iNotes = colIdx('note');

  // Group rows by parent email (or name if no email)
  const grouped = {};
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].match(/(".*?"|[^,]+)/g)?.map(c => c.trim().replace(/^"|"$/g, '')) || [];
    const parentName = (iName >= 0 ? cols[iName] : '') || '';
    const email = (iEmail >= 0 ? cols[iEmail] : '') || '';
    const phone = (iPhone >= 0 ? cols[iPhone] : '') || '';
    const childName = (iChild >= 0 ? cols[iChild] : '') || '';
    const dob = (iDob >= 0 ? cols[iDob] : '') || '';
    const allergies = (iAllergy >= 0 ? cols[iAllergy] : '') || '';
    const notes = (iNotes >= 0 ? cols[iNotes] : '') || '';

    const key = email || parentName;
    if (!key) continue;
    if (!grouped[key]) {
      grouped[key] = { parentName, email, phone, notes, children: [] };
    }
    if (childName) {
      grouped[key].children.push({ name: childName, dob: dob || null, allergies: allergies || null });
    }
    if (notes && !grouped[key].notes) grouped[key].notes = notes;
  }

  let count = 0;
  for (const rec of Object.values(grouped)) {
    if (rec.children.length === 0) {
      rec.children.push({ name: 'Unknown', dob: null, allergies: null });
    }
    await db.createRegistration({
      programId: 'imported',
      parentName: rec.parentName,
      parentEmail: rec.email,
      parentPhone: rec.phone,
      notes: rec.notes || null,
      children: rec.children.map(c => ({
        name: c.name, dob: c.dob || '', healthcareProvider: null, allergies: c.allergies,
      })),
      selectedDates: [],
      emailSubject: null,
      emailBody: null,
      programName: 'Imported',
    });
    count++;
  }

  req.session.flash = { type: 'success', msg: `Imported ${count} contact(s).` };
  res.redirect(303, '/admin/enrollments?tab=import');
}));

router.post('/enrollments/import-manual', requireAuth, asyncHandler(async (req, res) => {
  const { parent_name, email, phone, child_names, child_dobs, allergies, notes } = req.body;
  if (!parent_name || !child_names) {
    req.session.flash = { type: 'error', msg: 'Parent name and at least one child name are required.' };
    return res.redirect(303, '/admin/enrollments?tab=import');
  }

  const names = child_names.split(',').map(n => n.trim()).filter(Boolean);
  const dobs = (child_dobs || '').split(',').map(d => d.trim());
  const children = names.map((name, i) => ({
    name, dob: dobs[i] || '', healthcareProvider: null, allergies: allergies || null,
  }));

  await db.createRegistration({
    programId: 'imported',
    parentName: parent_name,
    parentEmail: email || '',
    parentPhone: phone || '',
    notes: notes || null,
    children,
    selectedDates: [],
    emailSubject: null,
    emailBody: null,
    programName: 'Imported',
  });

  req.session.flash = { type: 'success', msg: `Contact "${parent_name}" added.` };
  res.redirect(303, '/admin/enrollments?tab=import');
}));

// Rosters
router.get('/roster', requireAuth, asyncHandler(async (req, res) => {
  const programId = req.query.program;
  const weekStart = req.query.week;
  if (!programId || !weekStart) {
    req.session.flash = { type: 'error', msg: 'Program and week are required.' };
    return res.redirect('/admin/enrollments?tab=rosters');
  }
  const program = await db.getProgram(programId);
  if (!program) return res.status(404).send('Program not found');
  const startDate = new Date(weekStart + 'T00:00:00');
  const days = [];
  for (let i = 0; i < 7; i++) { const d = new Date(startDate); d.setDate(d.getDate() + i); days.push(d.toISOString().slice(0, 10)); }
  const registrations = await db.getRegistrationsByProgram(programId);
  const rosterByDay = [];
  for (const day of days) {
    const childrenForDay = [];
    for (const reg of registrations) {
      if ((reg.selectedDates || []).includes(day)) {
        // A registration may have no participant rows (e.g. CIT where applicant info
        // lives in custom responses). Fall back to one synthetic row per registration
        // so the participant appears on the roster regardless.
        const rows = (reg.children && reg.children.length > 0) ? reg.children : [{ name: null, dob: null, allergies: null }];
        for (const child of rows) {
          let age = null;
          if (child.dob) {
            const dob = new Date(child.dob + 'T00:00:00');
            if (!isNaN(dob)) {
              const dayDate = new Date(day + 'T00:00:00');
              age = dayDate.getFullYear() - dob.getFullYear();
              const md = dayDate.getMonth() - dob.getMonth();
              if (md < 0 || (md === 0 && dayDate.getDate() < dob.getDate())) age--;
            }
          }
          // Display name falls back to the contact name when the participant has none.
          const displayName = child.name || reg.parentName || '(no name)';
          childrenForDay.push({
            name: displayName,
            age,
            parentName: reg.parentName || '',
            parentPhone: reg.parentPhone || '',
            allergies: child.allergies || '',
            notes: reg.notes || '',
            customResponses: (reg.customResponses || []).filter(r => r && r.value),
          });
        }
      }
    }
    if (childrenForDay.length > 0) {
      childrenForDay.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      rosterByDay.push({ date: day, children: childrenForDay });
    }
  }
  res.render('admin/roster', { program, weekStart, rosterByDay });
}));

// ============ MESSAGES (tabbed: confirmations / bulk / inquiries) ============

router.get('/messages', requireAuth, asyncHandler(async (req, res) => {
  const tab = req.query.tab || 'confirmations';
  const filter = req.query.filter || 'all';
  const programs = await db.getAllPrograms();
  const emails = await db.getAllEmails();
  const pendingEmails = await db.countPendingEmails();
  const unreadInbox = await db.countUnreadInbound();
  const inquiries = await db.getAllInquiries();
  const newInquiries = await db.countNewInquiries();

  // Group inbound + outbound into conversation threads. The thread key is the
  // registration (preferred) or the counterparty address — for inbound that's
  // the sender, for outbound the recipient — so a person's whole exchange,
  // sent and received, collapses into one row.
  const dir = e => e.direction || 'out';
  const counterpartyOf = e => ((dir(e) === 'in' ? e.fromAddr : e.toAddr) || '').toLowerCase();
  // Outbound here is always sent from registration@; inbound carries its source.
  const mailboxOf = e => (dir(e) === 'in' ? (e.mailbox || 'info') : 'registration');
  const tsOf = e => e.receivedAt || e.createdAt || '';

  const threadMap = new Map();
  for (const e of emails) {
    const addr = counterpartyOf(e);
    const key = e.registrationId || ('addr:' + addr);
    if (!threadMap.has(key)) {
      threadMap.set(key, {
        key,
        registrationId: e.registrationId || null,
        addr,
        toAddr: addr,            // display label for the row
        childName: e.childName,
        programName: e.programName,
        parentName: e.parentName,
        mailboxes: new Set(),
        messages: [],
      });
    }
    const t = threadMap.get(key);
    t.messages.push(e);
    t.mailboxes.add(mailboxOf(e));
    // Backfill display fields from whichever message carries them.
    if (!t.childName && e.childName) t.childName = e.childName;
    if (!t.programName && e.programName) t.programName = e.programName;
    if (!t.parentName) t.parentName = e.parentName || e.fromName;
  }

  let threads = Array.from(threadMap.values()).map(t => {
    const sorted = t.messages.sort((a, b) => tsOf(a).localeCompare(tsOf(b)));
    const latest = sorted[sorted.length - 1];
    const hasDraft = sorted.some(m => m.status === 'draft');
    const hasFailed = sorted.some(m => m.status === 'failed');
    const unreadCount = sorted.filter(m => dir(m) === 'in' && !m.read).length;
    return {
      ...t,
      mailboxes: Array.from(t.mailboxes),
      isRegistration: !!t.registrationId,
      subject: sorted[0].subject,
      messageCount: sorted.length,
      latestDate: tsOf(latest),
      latestStatus: hasDraft ? 'draft' : hasFailed ? 'failed' : latest.status,
      latestDirection: dir(latest),
      latestSnippet: (dir(latest) === 'in' ? (latest.bodyText || '') : (latest.body || '')).replace(/<[^>]*>/g, '').slice(0, 120),
      unreadCount,
      latestId: latest.id,
      firstId: sorted[0].id,
    };
  });

  // Filter chips: mailbox (registration/info), unread, or the "confirmations"
  // label (threads that originated from a registration).
  if (filter === 'registration') threads = threads.filter(t => t.mailboxes.includes('registration'));
  else if (filter === 'info') threads = threads.filter(t => t.mailboxes.includes('info'));
  else if (filter === 'unread') threads = threads.filter(t => t.unreadCount > 0);
  else if (filter === 'confirmations') threads = threads.filter(t => t.isRegistration);

  // Sort: drafts first, then failed, then threads with unread replies, then by
  // most recent activity descending.
  const priority = t => (t.latestStatus === 'draft' ? 0 : t.latestStatus === 'failed' ? 1 : t.unreadCount > 0 ? 2 : 3);
  threads.sort((a, b) => {
    const pa = priority(a), pb = priority(b);
    if (pa !== pb) return pa - pb;
    return (b.latestDate || '').localeCompare(a.latestDate || '');
  });

  // For bulk tab: build week data
  const programWeeks = {};
  if (tab === 'bulk') {
    for (const p of programs) {
      const dates = await db.getDatesByProgram(p.id);
      const weekSet = new Map();
      for (const d of dates) {
        const dt = new Date(d.date + 'T00:00:00');
        const dow = dt.getDay();
        const mon = new Date(dt);
        mon.setDate(mon.getDate() - ((dow + 6) % 7));
        const monStr = mon.toISOString().slice(0, 10);
        if (!weekSet.has(monStr)) { const fri = new Date(mon); fri.setDate(fri.getDate() + 4); weekSet.set(monStr, fri.toISOString().slice(0, 10)); }
      }
      programWeeks[p.id] = { weeks: Array.from(weekSet.entries()).map(([mon, fri]) => ({ monday: mon, friday: fri })), dates: dates.map(d => d.date) };
    }
  }

  res.render('admin/messages', {
    tab, filter, threads, pendingEmails, unreadInbox, inquiries, newInquiries,
    programs, programWeeks, mailEnabled: mailConfig.isConfigured(),
  });
}));

// Pull new inbound mail from the Namecheap mailboxes on demand (called by the
// Inbox "Refresh" button and on Inbox load). Runs synchronously and returns
// counts; the page reloads if anything new arrived.
router.post('/messages/refresh', requireAuth, asyncHandler(async (req, res) => {
  if (!mailConfig.isConfigured()) {
    return res.json({ ok: false, configured: false, total: 0, error: 'No mailboxes configured.' });
  }
  try {
    const result = await imapSync.syncAllMailboxes();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('Inbox refresh failed:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
}));

// Soft delete (emails and inquiries — accepts comma-separated IDs)
router.post('/messages/delete', requireAuth, asyncHandler(async (req, res) => {
  const { type, item_id } = req.body;
  const adminUser = process.env.ADMIN_USER || 'admin';
  const ids = item_id.split(',').map(s => s.trim()).filter(Boolean);
  for (const id of ids) {
    await db.softDeleteMessage(type, id, adminUser);
  }
  const tab = type === 'email' ? 'confirmations' : 'inquiries';
  req.session.flash = { type: 'success', msg: ids.length > 1 ? `${ids.length} messages deleted.` : 'Deleted.' };
  res.redirect(303, '/admin/messages?tab=' + tab);
}));

// Render a conversation (inbound + outbound interleaved), marking any unread
// inbound messages read and computing where/how a reply should be sent.
async function renderThread(req, res, { emails, registration, registrationId }) {
  if (!emails || emails.length === 0) return res.status(404).send('No messages found for this thread.');
  emails.sort((a, b) => (a.receivedAt || a.createdAt || '').localeCompare(b.receivedAt || b.createdAt || ''));

  // Mark inbound messages read on open.
  await Promise.all(emails
    .filter(e => (e.direction || 'out') === 'in' && !e.read)
    .map(e => db.markEmailRead(e.id).catch(() => {})));

  const latest = emails[emails.length - 1];
  const latestInbound = [...emails].reverse().find(e => (e.direction || 'out') === 'in');

  // Reply target: the counterparty address. Reply-from mailbox: the account the
  // latest inbound arrived in, else registration.
  const replyTo = (latestInbound ? latestInbound.fromAddr
    : (emails.find(e => e.toAddr) || {}).toAddr) || '';
  const replyAccount = (latestInbound && latestInbound.mailbox) || 'registration';

  // Thread headers so the recipient's client groups the reply.
  const inReplyTo = (latestInbound && latestInbound.messageId) || latest.messageId || '';
  const references = emails.map(e => e.messageId).filter(Boolean).join(' ');

  res.render('admin/thread_view', {
    emails, registration: registration || null, registrationId: registrationId || null,
    latest, replyTo, replyAccount, inReplyTo, references,
    mailEnabled: smtp.isConfigured(),
  });
}

// Thread view by registration (confirmations + any replies linked to it).
router.get('/messages/thread/:registrationId', requireAuth, asyncHandler(async (req, res) => {
  const registrationId = req.params.registrationId;
  const emails = await db.getEmailsByRegistration(registrationId);
  if (emails.length === 0) return res.status(404).send('No messages found for this thread.');
  const registration = await db.getRegistration(registrationId);
  await renderThread(req, res, { emails, registration, registrationId });
}));

// Thread view by address (inbound/outbound with someone not tied to a registration).
router.get('/messages/thread/addr/:addr', requireAuth, asyncHandler(async (req, res) => {
  const addr = req.params.addr;
  const emails = await db.getThreadByAddr(addr);
  await renderThread(req, res, { emails, registration: null, registrationId: null });
}));

// Confirmation email edit/send
router.get('/messages/emails/:id/edit', requireAuth, asyncHandler(async (req, res) => {
  const email = await db.getEmail(req.params.id);
  if (!email) return res.status(404).send('Not found');
  const registration = email.registrationId ? await db.getRegistration(email.registrationId) : null;
  res.render('admin/email_edit', { email, registration });
}));

router.post('/messages/emails/:id/update', requireAuth, asyncHandler(async (req, res) => {
  await db.updateEmailDraft(req.params.id, req.body.subject, req.body.body);
  req.session.flash = { type: 'success', msg: 'Email updated.' };
  res.redirect('/admin/messages/emails/' + req.params.id + '/edit');
}));

router.post('/messages/emails/:id/upload-url', requireAuth, asyncHandler(async (req, res) => {
  const { filename, contentType } = req.body;
  const result = await storage.getUploadUrl('email-attachments', filename, contentType);
  res.json(result);
}));

router.post('/messages/emails/:id/attach', requireAuth, asyncHandler(async (req, res) => {
  const { filename, url, key, contentType } = req.body;
  await db.addEmailAttachment(req.params.id, { filename, url, key, contentType });
  req.session.flash = { type: 'success', msg: `Attachment "${filename}" added.` };
  res.redirect(303, '/admin/messages/emails/' + req.params.id + '/edit');
}));

router.post('/messages/emails/:id/detach', requireAuth, asyncHandler(async (req, res) => {
  const { index, key } = req.body;
  if (key) { try { await storage.deleteFile(key); } catch (e) { console.error('S3 delete:', e); } }
  await db.removeEmailAttachment(req.params.id, index);
  req.session.flash = { type: 'success', msg: 'Attachment removed.' };
  res.redirect(303, '/admin/messages/emails/' + req.params.id + '/edit');
}));

// Follow-up to an existing confirmation email (from email_edit). Delegates to
// the shared SMTP-first reply path.
router.post('/messages/emails/:id/followup', requireAuth, asyncHandler(async (req, res) => {
  const original = await db.getEmail(req.params.id);
  if (!original) {
    req.session.flash = { type: 'error', msg: 'Original email not found.' };
    return res.redirect('/admin/messages?tab=confirmations');
  }
  const { subject, body } = req.body;
  if (!subject || !body || !body.trim()) {
    req.session.flash = { type: 'error', msg: 'Subject and body are required.' };
    return res.redirect(303, '/admin/messages/emails/' + req.params.id + '/edit');
  }
  try {
    await deliverReply({
      to: original.toAddr,
      account: original.mailbox || 'registration',
      subject, body,
      inReplyTo: original.messageId,
      references: original.messageId,
      registrationId: original.registrationId,
      meta: original,
    });
    req.session.flash = { type: 'success', msg: `Follow-up sent to ${original.toAddr}.` };
  } catch (err) {
    console.error('Follow-up error:', err);
    req.session.flash = { type: 'error', msg: 'Send failed: ' + err.message };
  }
  if (original.registrationId) {
    res.redirect(303, '/admin/messages/thread/' + original.registrationId);
  } else {
    res.redirect(303, '/admin/messages/thread/addr/' + encodeURIComponent(original.toAddr));
  }
}));

// Reply from the inbox thread view (works for registration and address threads).
router.post('/messages/reply', requireAuth, asyncHandler(async (req, res) => {
  const { to, account, subject, body, in_reply_to, references, registration_id } = req.body;
  const backTo = registration_id
    ? '/admin/messages/thread/' + registration_id
    : '/admin/messages/thread/addr/' + encodeURIComponent(to || '');
  if (!to || !subject || !body || !body.trim()) {
    req.session.flash = { type: 'error', msg: 'Recipient, subject, and message are required.' };
    return res.redirect(303, backTo);
  }
  let meta = {};
  if (registration_id) {
    const reg = await db.getRegistration(registration_id);
    if (reg) {
      meta = {
        parentName: reg.parentName,
        childName: (reg.children || []).map(c => c.name).filter(Boolean).join(', '),
        programName: reg.programName,
      };
    }
  }
  try {
    await deliverReply({
      to,
      account: account || 'registration',
      subject, body,
      inReplyTo: in_reply_to,
      references,
      registrationId: registration_id || null,
      meta,
    });
    req.session.flash = { type: 'success', msg: `Reply sent to ${to}.` };
  } catch (err) {
    console.error('Reply error:', err);
    req.session.flash = { type: 'error', msg: 'Send failed: ' + err.message };
  }
  res.redirect(303, backTo);
}));

router.post('/messages/emails/:id/send', requireAuth, asyncHandler(async (req, res) => {
  // Save any edits from the form before sending
  if (req.body.subject && req.body.body) {
    try { await db.updateEmailDraft(req.params.id, req.body.subject, req.body.body); } catch (e) { /* may fail if not draft */ }
  }

  const email = await db.getEmail(req.params.id);
  if (!email || email.status !== 'draft') {
    req.session.flash = { type: 'error', msg: 'Email not found or already sent.' };
    return res.redirect('/admin/messages?tab=confirmations');
  }
  if (!mailer.isConfigured()) {
    req.session.flash = { type: 'error', msg: 'SES not configured.' };
    return res.redirect('/admin/messages/emails/' + req.params.id + '/edit');
  }
  try {
    // Build attachments from S3
    const attachments = [];
    if (email.attachments && email.attachments.length > 0) {
      const { GetObjectCommand } = require('@aws-sdk/client-s3');
      const { S3Client } = require('@aws-sdk/client-s3');
      const s3Config = { region: process.env.WIW_AWS_REGION || process.env.AWS_REGION || 'us-west-1' };
      if (process.env.WIW_ACCESS_KEY_ID) {
        s3Config.credentials = { accessKeyId: process.env.WIW_ACCESS_KEY_ID, secretAccessKey: process.env.WIW_SECRET_ACCESS_KEY };
      }
      const s3 = new S3Client(s3Config);
      const bucket = process.env.WIW_S3_BUCKET || 'wiw-media-assets';
      for (const att of email.attachments) {
        const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: att.key }));
        const chunks = [];
        for await (const chunk of obj.Body) chunks.push(chunk);
        attachments.push({ filename: att.filename, content: Buffer.concat(chunks), contentType: att.contentType });
      }
    }
    const sent = await mailer.send(email.toAddr, email.subject, email.body, 'registration', attachments);
    await db.markEmailSent(email.id, sent && sent.messageId);
    req.session.flash = { type: 'success', msg: `Email sent to ${email.toAddr}.` };
  } catch (err) {
    console.error('SES error:', err);
    await db.markEmailFailed(email.id);
    req.session.flash = { type: 'error', msg: 'Send failed: ' + err.message };
  }
  res.redirect('/admin/messages?tab=confirmations');
}));

// Bulk send
router.post('/messages/bulk/upload-url', requireAuth, asyncHandler(async (req, res) => {
  const { filename, contentType } = req.body;
  const result = await storage.getUploadUrl('bulk-attachments', filename, contentType);
  res.json(result);
}));

router.post('/messages/bulk/recipients', requireAuth, asyncHandler(async (req, res) => {
  const { scope, programId, date, weekStart } = req.body;
  let emails = [];
  if (scope === 'all') { emails = await db.getAllEmails_addresses(); }
  else if (scope === 'day' && programId && date) { emails = await db.getEmailsByDate(programId, date); }
  else if (scope === 'week' && programId && weekStart) { emails = await db.getEmailsByWeek(programId, weekStart); }
  else if (scope === 'program' && programId) {
    const regs = await db.getRegistrationsByProgram(programId);
    const set = new Set(); regs.forEach(r => { if (r.parentEmail) set.add(r.parentEmail); }); emails = Array.from(set);
  }
  res.json({ emails, count: emails.length });
}));

router.post('/messages/bulk/send', requireAuth, asyncHandler(async (req, res) => {
  const { subject, body, recipients, attachment_keys, body_format } = req.body;
  if (!subject || !body || !recipients) { req.session.flash = { type: 'error', msg: 'Subject, body, and recipients are required.' }; return res.redirect(303, '/admin/messages?tab=bulk'); }
  const emailList = recipients.split(',').map(e => e.trim()).filter(Boolean);
  if (emailList.length === 0) { req.session.flash = { type: 'error', msg: 'No recipients.' }; return res.redirect(303, '/admin/messages?tab=bulk'); }
  if (!mailer.isConfigured()) { req.session.flash = { type: 'error', msg: 'SES not configured.' }; return res.redirect(303, '/admin/messages?tab=bulk'); }
  try {
    // Fetch attachments from S3
    const attachments = [];
    if (attachment_keys) {
      const attList = JSON.parse(attachment_keys);
      const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
      const s3Config = { region: process.env.WIW_AWS_REGION || process.env.AWS_REGION || 'us-west-1' };
      if (process.env.WIW_ACCESS_KEY_ID) {
        s3Config.credentials = { accessKeyId: process.env.WIW_ACCESS_KEY_ID, secretAccessKey: process.env.WIW_SECRET_ACCESS_KEY };
      }
      const s3 = new S3Client(s3Config);
      const bucket = process.env.WIW_S3_BUCKET || 'wiw-media-assets';
      for (const att of attList) {
        const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: att.key }));
        const chunks = []; for await (const chunk of obj.Body) chunks.push(chunk);
        attachments.push({ filename: att.filename, content: Buffer.concat(chunks), contentType: att.contentType });
      }
    }
    const count = await mailer.sendBulk(emailList, subject, body, 'info', attachments, body_format || 'text');
    req.session.flash = { type: 'success', msg: `Email sent to ${count} recipient(s).` };
  } catch (err) {
    console.error('Bulk email error:', err);
    req.session.flash = { type: 'error', msg: 'Send failed: ' + err.message };
  }
  res.redirect(303, '/admin/messages?tab=bulk');
}));

// Inquiries
router.get('/messages/inquiries/:id', requireAuth, asyncHandler(async (req, res) => {
  const inquiry = await db.getInquiry(req.params.id);
  if (!inquiry) return res.status(404).send('Not found');
  res.render('admin/inquiry_detail', { inquiry });
}));

router.post('/messages/inquiries/:id/reply', requireAuth, asyncHandler(async (req, res) => {
  const { reply } = req.body;
  const inquiry = await db.getInquiry(req.params.id);
  if (!inquiry) return res.status(404).send('Not found');
  if (!reply || !reply.trim()) {
    req.session.flash = { type: 'error', msg: 'Reply cannot be empty.' };
    return res.redirect(303, '/admin/messages/inquiries/' + req.params.id);
  }
  if (inquiry.email && mailer.isConfigured()) {
    try { await mailer.send(inquiry.email, `Re: ${inquiry.subject}`, reply, 'info'); }
    catch (err) {
      console.error('Failed to send inquiry reply:', err);
      req.session.flash = { type: 'error', msg: 'Failed to send: ' + err.message };
      return res.redirect(303, '/admin/messages/inquiries/' + req.params.id);
    }
  }
  await db.replyToInquiry(req.params.id, reply);
  req.session.flash = { type: 'success', msg: inquiry.email ? `Reply sent to ${inquiry.email}.` : 'Reply saved (no email on file).' };
  res.redirect(303, '/admin/messages?tab=inquiries');
}));

function csvEsc(val) { if (!val) return ''; const s = String(val); return (s.includes(',') || s.includes('"') || s.includes('\n')) ? '"' + s.replace(/"/g, '""') + '"' : s; }

module.exports = router;
