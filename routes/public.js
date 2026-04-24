const express = require('express');
const router = express.Router();
const db = require('../db/dynamo');
const site = require('../lib/site');

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.get('/', asyncHandler(async (req, res) => {
  const programs = await db.getAllPrograms();
  const page = await db.getPage('home') || {};
  res.render('home', { programs, page });
}));

router.get('/waiver', asyncHandler(async (req, res) => {
  const page = await db.getPage('waiver') || {};
  if (req.query.format === 'json') {
    return res.json({ body: page.body || null });
  }
  res.render('waiver', { page });
}));

router.get('/about', asyncHandler(async (req, res) => {
  const page = await db.getPage('about') || {};
  res.render('about', { page });
}));

router.get('/programs/:slug', asyncHandler(async (req, res) => {
  // Try slug first, fall back to ID for backward compat
  let program = await db.getProgramBySlug(req.params.slug);
  if (!program) program = await db.getProgram(req.params.slug);
  if (!program) return res.status(404).send('Program not found');
  // Redirect old ID URLs to slug URLs
  if (req.params.slug !== program.slug) {
    return res.redirect(301, '/programs/' + program.slug);
  }
  const programs = await db.getAllPrograms();
  res.render('program', { program, programs });
}));

router.get('/register/thanks', (req, res) => {
  res.render('thanks');
});

router.get('/register/:slug?', asyncHandler(async (req, res) => {
  const programs = await db.getAllPrograms();
  let selectedProgramId = null;

  if (req.params.slug) {
    // /register/nature-camps
    const program = programs.find(p => p.slug === req.params.slug);
    if (program) selectedProgramId = program.id;
  } else if (req.query.program) {
    // /register?program=prog_xxx (backward compat) → redirect to slug URL
    const program = programs.find(p => p.id === req.query.program);
    if (program && program.slug) {
      return res.redirect(301, '/register/' + program.slug);
    }
    selectedProgramId = req.query.program;
  }

  res.render('register', { programs, selectedProgramId });
}));

router.post('/register', asyncHandler(async (req, res) => {
  const {
    program_id, parent_name, parent_email, parent_phone,
    notes, selected_dates,
  } = req.body;

  // Look up program early for slug-based redirects
  const program = program_id ? await db.getProgram(program_id) : null;
  const regUrl = program && program.slug ? '/register/' + program.slug : '/register';

  const rawChildren = req.body.children || {};
  const children = Object.values(rawChildren).filter(c => c.name && c.dob);

  if (!program_id || !parent_name || !parent_email || !parent_phone ||
      children.length === 0 || !selected_dates) {
    req.session.flash = { type: 'error', msg: 'Please fill in all required fields, add at least one child, and select dates.' };
    return res.redirect(303, regUrl);
  }

  const dateList = selected_dates.split(',').map(d => d.trim()).filter(Boolean);
  if (dateList.length === 0) {
    req.session.flash = { type: 'error', msg: 'Please select at least one date.' };
    return res.redirect(303, regUrl);
  }

  // Check capacity on each selected date
  const programDates = await db.getDatesByProgram(program_id);
  const dateCapMap = {};
  programDates.forEach(d => { dateCapMap[d.date] = { capacity: d.maxCapacity || 12, enrolled: d.enrolled || 0 }; });
  const fullDates = dateList.filter(d => {
    const info = dateCapMap[d];
    return info && info.enrolled >= info.capacity;
  });
  if (fullDates.length > 0) {
    const fullStr = fullDates.map(d => {
      const dt = new Date(d + 'T00:00:00');
      return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    }).join(', ');
    req.session.flash = { type: 'error', msg: `The following date(s) are at capacity and cannot be booked: ${fullStr}. Please adjust your selection.` };
    return res.redirect(303, regUrl);
  }

  const emailRe = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;
  const phoneDigits = parent_phone.replace(/\D/g, '');
  if (!emailRe.test(parent_email)) {
    req.session.flash = { type: 'error', msg: 'Please enter a valid email address.' };
    return res.redirect(303, regUrl);
  }
  if (phoneDigits.length !== 10) {
    req.session.flash = { type: 'error', msg: 'Please enter a valid 10-digit phone number.' };
    return res.redirect(303, regUrl);
  }

  // Compose confirmation email
  const dateListStr = dateList.sort().map(d => {
    const dt = new Date(d + 'T00:00:00');
    return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }).join('\n  ');

  const childNames = children.map(c => c.name);
  const childListStr = childNames.length === 1
    ? childNames[0]
    : childNames.slice(0, -1).join(', ') + ' and ' + childNames[childNames.length - 1];

  const programName = program ? program.name : 'our program';

  const emailBody = `Dear ${parent_name},

Thank you for registering ${childListStr} for ${programName}!

Enrolled dates:
  ${dateListStr}

We're excited to have ${childListStr} join us. Please arrive by 8:45 AM on the first day. Don't forget sunscreen, a water bottle, and a sense of adventure!

If you have any questions, reply to this email or call us at ${site.phone}.

Warm regards,
${site.name} Team`;

  try {
    await db.createRegistration({
      programId: program_id,
      parentName: parent_name,
      parentEmail: parent_email,
      parentPhone: parent_phone,
      notes: notes || null,
      children: children.map(c => ({
        name: c.name,
        dob: c.dob,
        healthcareProvider: c.healthcare_provider || null,
        allergies: c.allergies || null,
      })),
      selectedDates: dateList,
      emailSubject: `Registration Confirmation — ${programName}`,
      emailBody,
      programName,
    });
    req.session.flash = { type: 'success', msg: 'Registration complete! You will receive a confirmation email shortly.' };
    res.redirect(303, '/register/thanks');
  } catch (err) {
    console.error('Registration error:', err);
    const isCapacity = err.name === 'TransactionCanceledException' &&
      (err.message || '').includes('ConditionalCheckFailed');
    req.session.flash = {
      type: 'error',
      msg: isCapacity
        ? 'One or more selected dates just reached capacity. Please refresh and try again with different dates.'
        : 'Something went wrong. Please try again.',
    };
    res.redirect(303, regUrl);
  }
}));

router.post('/inquiry', asyncHandler(async (req, res) => {
  const { name, email, phone, subject, message } = req.body;

  if (!subject || !message) {
    return res.status(400).json({ error: 'Subject and message are required.' });
  }
  if (!email && !phone) {
    return res.status(400).json({ error: 'Please provide at least an email or phone number.' });
  }
  if (message.length > 250) {
    return res.status(400).json({ error: 'Message must be 250 characters or less.' });
  }

  await db.createInquiry({ name, email, phone, subject, message });

  // Notify admin via email
  const mailer = require('../lib/mailer');
  if (mailer.isConfigured()) {
    try {
      const contact = [email, phone].filter(Boolean).join(' / ');
      await mailer.send(
        process.env.SES_FROM_EMAIL_INFO,
        `New Inquiry: ${subject}`,
        `New inquiry from ${name || 'Anonymous'} (${contact}):\n\n${message}`,
        'info'
      );
    } catch (err) {
      console.error('Failed to send inquiry notification:', err);
    }
  }

  res.json({ ok: true });
}));

module.exports = router;
