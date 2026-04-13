const express = require('express');
const router = express.Router();
const db = require('../db/dynamo');
const { validateAdmin, requireAuth } = require('../lib/auth');
const mailer = require('../lib/mailer');
const storage = require('../lib/storage');

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.get('/login', (req, res) => {
  res.render('admin/login');
});

router.post('/login', (req, res) => {
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

// Dashboard
router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const programs = await db.getAllPrograms();
  const stats = await db.getDashboardStats();
  const pendingEmails = await db.countPendingEmails();
  const newInquiries = await db.countNewInquiries();
  res.render('admin/dashboard', { programs, stats, pendingEmails, newInquiries });
}));

// Enrollments
router.get('/enrollments', requireAuth, asyncHandler(async (req, res) => {
  const programId = req.query.program || null;
  const programs = await db.getAllPrograms();
  const enrollments = await db.getEnrollments(programId);

  // Build available weeks for the roster picker
  let weeks = [];
  if (programId) {
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

  res.render('admin/enrollments', { enrollments, programs, selectedProgramId: programId, weeks });
}));

// Date management
router.get('/dates', requireAuth, asyncHandler(async (req, res) => {
  const programs = await db.getAllPrograms();
  const programId = req.query.program || (programs[0]?.id || null);

  let dates = [];
  if (programId) {
    dates = await db.getDatesByProgram(programId);
  }
  res.render('admin/dates', { programs, dates, selectedProgramId: programId });
}));

router.post('/dates/add', requireAuth, asyncHandler(async (req, res) => {
  const { program_id, dates, max_capacity } = req.body;
  const cap = parseInt(max_capacity, 10) || 12;
  const dateList = dates.split(',').map(d => d.trim()).filter(Boolean);

  await db.addDates(program_id, dateList, cap);

  req.session.flash = { type: 'success', msg: `Added ${dateList.length} date(s).` };
  res.redirect('/admin/dates?program=' + program_id);
}));

router.post('/dates/remove', requireAuth, asyncHandler(async (req, res) => {
  const { program_id, date_to_remove } = req.body;
  const result = await db.removeDate(program_id, date_to_remove);
  if (!result.ok) {
    req.session.flash = { type: 'error', msg: result.reason };
  } else {
    req.session.flash = { type: 'success', msg: 'Date removed.' };
  }
  res.redirect('/admin/dates?program=' + program_id);
}));

// Email queue
router.get('/emails', requireAuth, asyncHandler(async (req, res) => {
  const emails = await db.getAllEmails();
  res.render('admin/emails', { emails });
}));

router.get('/emails/:id/edit', requireAuth, asyncHandler(async (req, res) => {
  const email = await db.getEmail(req.params.id);
  if (!email) return res.status(404).send('Not found');
  res.render('admin/email_edit', { email });
}));

router.post('/emails/:id/update', requireAuth, asyncHandler(async (req, res) => {
  const { subject, body } = req.body;
  await db.updateEmailDraft(req.params.id, subject, body);
  req.session.flash = { type: 'success', msg: 'Email updated.' };
  res.redirect('/admin/emails/' + req.params.id + '/edit');
}));

router.post('/emails/:id/send', requireAuth, asyncHandler(async (req, res) => {
  const email = await db.getEmail(req.params.id);
  if (!email || email.status !== 'draft') {
    req.session.flash = { type: 'error', msg: 'Email not found or already sent.' };
    return res.redirect('/admin/emails');
  }

  if (!mailer.isConfigured()) {
    req.session.flash = { type: 'error', msg: 'SES not configured. Set SES_FROM_EMAIL environment variable.' };
    return res.redirect('/admin/emails/' + req.params.id + '/edit');
  }

  try {
    await mailer.send(email.toAddr, email.subject, email.body);
    await db.markEmailSent(email.id);
    req.session.flash = { type: 'success', msg: `Email sent to ${email.toAddr}.` };
  } catch (err) {
    console.error('SES error:', err);
    await db.markEmailFailed(email.id);
    req.session.flash = { type: 'error', msg: 'Send failed: ' + err.message };
  }
  res.redirect('/admin/emails');
}));

// Payment status
router.get('/status', requireAuth, asyncHandler(async (req, res) => {
  const programId = req.query.program || null;
  const programs = await db.getAllPrograms();
  const enrollments = await db.getEnrollments(programId);

  // Attach confirmation dates from email queue
  const emails = await db.getAllEmails();
  const sentByReg = {};
  emails.forEach(e => {
    if (e.status === 'sent' && e.registrationId) {
      if (!sentByReg[e.registrationId] || e.sentAt > sentByReg[e.registrationId]) {
        sentByReg[e.registrationId] = e.sentAt;
      }
    }
  });

  const rows = enrollments.map(r => ({
    ...r,
    confirmationDate: sentByReg[r.id] || null,
  }));

  // Sort: unpaid first, then by amount
  rows.sort((a, b) => {
    const aHas = a.paymentAmount != null ? 1 : 0;
    const bHas = b.paymentAmount != null ? 1 : 0;
    if (aHas !== bHas) return aHas - bHas;
    return (a.paymentAmount || 0) - (b.paymentAmount || 0);
  });

  res.render('admin/status', { rows, programs, selectedProgramId: programId });
}));

router.post('/status/update', requireAuth, asyncHandler(async (req, res) => {
  const { registration_id, payment_date, payment_amount, payment_notes } = req.body;
  const amount = payment_amount !== '' ? parseFloat(payment_amount) : null;
  await db.updatePayment(registration_id, payment_date || null, amount, payment_notes || null);
  req.session.flash = { type: 'success', msg: 'Payment info updated.' };
  res.redirect(303, req.get('Referer') || '/admin/status');
}));

router.get('/status/csv', requireAuth, asyncHandler(async (req, res) => {
  const programId = req.query.program || null;
  const enrollments = await db.getEnrollments(programId);

  const emails = await db.getAllEmails();
  const sentByReg = {};
  emails.forEach(e => {
    if (e.status === 'sent' && e.registrationId) {
      sentByReg[e.registrationId] = e.sentAt;
    }
  });

  const header = 'Parent Name,Email,Phone,Children,DOBs,Program,Dates,Confirmation Date,Payment Date,Payment Amount,Notes';
  const csvRows = enrollments.map(r => {
    const childNames = (r.children || []).map(c => c.name).join('; ');
    const childDobs = (r.children || []).map(c => c.dob).join('; ');
    const dates = (r.selectedDates || []).sort().join('; ');
    return [
      csvEscape(r.parentName),
      csvEscape(r.parentEmail),
      csvEscape(r.parentPhone),
      csvEscape(childNames),
      csvEscape(childDobs),
      csvEscape(r.programName),
      csvEscape(dates),
      csvEscape(sentByReg[r.id] || ''),
      csvEscape(r.paymentDate || ''),
      r.paymentAmount != null ? r.paymentAmount.toFixed(2) : '',
      csvEscape(r.paymentNotes || ''),
    ].join(',');
  });

  const csv = header + '\n' + csvRows.join('\n');
  const filename = programId
    ? `status-${programId}-${new Date().toISOString().slice(0, 10)}.csv`
    : `status-all-${new Date().toISOString().slice(0, 10)}.csv`;
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
}));

function csvEscape(val) {
  if (!val) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

// Rosters
router.get('/roster', requireAuth, asyncHandler(async (req, res) => {
  const programId = req.query.program;
  const weekStart = req.query.week;
  if (!programId || !weekStart) {
    req.session.flash = { type: 'error', msg: 'Program and week are required.' };
    return res.redirect('/admin/enrollments');
  }

  const program = await db.getProgram(programId);
  if (!program) return res.status(404).send('Program not found');

  // Build the 7 days of the week
  const startDate = new Date(weekStart + 'T00:00:00');
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(startDate);
    d.setDate(d.getDate() + i);
    days.push(d.toISOString().slice(0, 10));
  }

  // Get all registrations for this program
  const registrations = await db.getRegistrationsByProgram(programId);

  // For each day, find children enrolled
  const rosterByDay = [];
  for (const day of days) {
    const childrenForDay = [];
    for (const reg of registrations) {
      if ((reg.selectedDates || []).includes(day)) {
        for (const child of (reg.children || [])) {
          const dob = new Date(child.dob + 'T00:00:00');
          const dayDate = new Date(day + 'T00:00:00');
          let age = dayDate.getFullYear() - dob.getFullYear();
          const monthDiff = dayDate.getMonth() - dob.getMonth();
          if (monthDiff < 0 || (monthDiff === 0 && dayDate.getDate() < dob.getDate())) {
            age--;
          }
          childrenForDay.push({
            name: child.name,
            age,
            parentName: reg.parentName,
            parentPhone: reg.parentPhone,
            allergies: child.allergies || '',
            notes: reg.notes || '',
          });
        }
      }
    }
    if (childrenForDay.length > 0) {
      childrenForDay.sort((a, b) => a.name.localeCompare(b.name));
      rosterByDay.push({ date: day, children: childrenForDay });
    }
  }

  res.render('admin/roster', { program, weekStart, rosterByDay });
}));

// Inquiries
router.get('/inquiries', requireAuth, asyncHandler(async (req, res) => {
  const inquiries = await db.getAllInquiries();
  res.render('admin/inquiries', { inquiries });
}));

router.get('/inquiries/:id', requireAuth, asyncHandler(async (req, res) => {
  const inquiry = await db.getInquiry(req.params.id);
  if (!inquiry) return res.status(404).send('Not found');
  res.render('admin/inquiry_detail', { inquiry });
}));

router.post('/inquiries/:id/reply', requireAuth, asyncHandler(async (req, res) => {
  const { reply } = req.body;
  const inquiry = await db.getInquiry(req.params.id);
  if (!inquiry) return res.status(404).send('Not found');

  if (!reply || !reply.trim()) {
    req.session.flash = { type: 'error', msg: 'Reply cannot be empty.' };
    return res.redirect(303, '/admin/inquiries/' + req.params.id);
  }

  // Send the reply via SES
  if (inquiry.email && mailer.isConfigured()) {
    try {
      await mailer.send(inquiry.email, `Re: ${inquiry.subject}`, reply, 'info');
    } catch (err) {
      console.error('Failed to send inquiry reply:', err);
      req.session.flash = { type: 'error', msg: 'Failed to send: ' + err.message };
      return res.redirect(303, '/admin/inquiries/' + req.params.id);
    }
  }

  await db.replyToInquiry(req.params.id, reply);
  req.session.flash = { type: 'success', msg: inquiry.email ? `Reply sent to ${inquiry.email}.` : 'Reply saved (no email on file).' };
  res.redirect(303, '/admin/inquiries');
}));

// Program content editor
router.get('/programs/:id/edit', requireAuth, asyncHandler(async (req, res) => {
  const program = await db.getProgram(req.params.id);
  if (!program) return res.status(404).send('Program not found');
  res.render('admin/program_edit', { program });
}));

router.post('/programs/:id/content', requireAuth, asyncHandler(async (req, res) => {
  const { long_description } = req.body;
  await db.updateProgramDescription(req.params.id, long_description);
  req.session.flash = { type: 'success', msg: 'Content updated.' };
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
  if (key) {
    try { await storage.deleteFile(key); } catch (e) { console.error('S3 delete error:', e); }
  }
  await db.removeProgramMedia(req.params.id, index);
  req.session.flash = { type: 'success', msg: 'Media removed.' };
  res.redirect(303, '/admin/programs/' + req.params.id + '/edit');
}));

router.post('/programs/:id/hero', requireAuth, asyncHandler(async (req, res) => {
  const { url } = req.body;
  await db.updateProgramHero(req.params.id, url || null);
  req.session.flash = { type: 'success', msg: 'Hero image updated.' };
  res.redirect(303, '/admin/programs/' + req.params.id + '/edit');
}));

// Program management
router.post('/programs/add', requireAuth, asyncHandler(async (req, res) => {
  const { name, description } = req.body;
  if (!name) {
    req.session.flash = { type: 'error', msg: 'Program name is required.' };
    return res.redirect('/admin');
  }
  try {
    await db.createProgram(name, description);
    req.session.flash = { type: 'success', msg: `Program "${name}" created.` };
  } catch (err) {
    req.session.flash = { type: 'error', msg: 'Program already exists or error creating.' };
  }
  res.redirect('/admin');
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
  res.redirect('/admin');
}));

module.exports = router;
