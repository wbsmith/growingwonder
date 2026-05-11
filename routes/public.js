const express = require('express');
const router = express.Router();
const db = require('../db/dynamo');
const site = require('../lib/site');
const { publicFormLimiter } = require('../lib/security');

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
  // Attach a materialized formConfig to every program so the view and the
  // dropdown-change handler can read uniform structure regardless of whether
  // a program has been migrated to the new schema yet.
  programs.forEach(p => { p.formConfig = db.materializeFormConfig(p); });

  let selectedProgramId = null;
  let arrivedViaSlug = false;

  if (req.params.slug) {
    const program = programs.find(p => p.slug === req.params.slug);
    if (program) { selectedProgramId = program.id; arrivedViaSlug = true; }
  } else if (req.query.program) {
    const program = programs.find(p => p.id === req.query.program);
    if (program && program.slug) {
      return res.redirect(301, '/register/' + program.slug);
    }
    selectedProgramId = req.query.program;
  }

  const selectedProgram = selectedProgramId ? programs.find(p => p.id === selectedProgramId) : null;
  // Hide selector only when the user landed via the program's slug URL AND that
  // program has the selector turned off in its formConfig.
  const hideSelector = !!(arrivedViaSlug && selectedProgram && selectedProgram.formConfig.programSelector.show === false);

  res.render('register', { programs, selectedProgramId, selectedProgram, hideSelector });
}));

router.post('/register', publicFormLimiter, asyncHandler(async (req, res) => {
  const {
    program_id, parent_name, parent_email, parent_phone,
    notes, selected_dates,
  } = req.body;

  // Look up program early for slug-based redirects + formConfig
  const program = program_id ? await db.getProgram(program_id) : null;
  const regUrl = program && program.slug ? '/register/' + program.slug : '/register';
  const fc = program ? db.materializeFormConfig(program) : null;

  const rawChildren = req.body.children || {};
  // Drop empty rows. A row counts only if at least one shown field has a value.
  const children = Object.values(rawChildren).filter(c => c && (c.name || c.dob || c.healthcare_provider || c.allergies));

  if (!program_id || children.length === 0 || !selected_dates) {
    req.session.flash = { type: 'error', msg: 'Please fill in all required fields, add at least one participant, and select dates.' };
    return res.redirect(303, regUrl);
  }

  const dateList = selected_dates.split(',').map(d => d.trim()).filter(Boolean);
  if (dateList.length === 0) {
    req.session.flash = { type: 'error', msg: 'Please select at least one date.' };
    return res.redirect(303, regUrl);
  }

  // Capacity check
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

  // Per-field validation driven by formConfig. A field that is "shown" and
  // "required" must be provided. Hidden fields are ignored (and not stored).
  const missing = [];
  if (fc.contactName.show && fc.contactName.required && !parent_name) missing.push(fc.contactName.label);
  if (fc.contactEmail.show && fc.contactEmail.required && !parent_email) missing.push(fc.contactEmail.label);
  if (fc.contactPhone.show && fc.contactPhone.required && !parent_phone) missing.push(fc.contactPhone.label);
  if (missing.length > 0) {
    req.session.flash = { type: 'error', msg: 'Please complete: ' + missing.join(', ') + '.' };
    return res.redirect(303, regUrl);
  }

  // Format validation only on fields that are both shown and provided.
  const emailRe = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;
  if (fc.contactEmail.show && parent_email && !emailRe.test(parent_email)) {
    req.session.flash = { type: 'error', msg: 'Please enter a valid email address.' };
    return res.redirect(303, regUrl);
  }
  if (fc.contactPhone.show && parent_phone) {
    const phoneDigits = parent_phone.replace(/\D/g, '');
    if (phoneDigits.length !== 10) {
      req.session.flash = { type: 'error', msg: 'Please enter a valid 10-digit phone number.' };
      return res.redirect(303, regUrl);
    }
  }

  // Per-participant required-field validation.
  const pf = fc.participants.fields;
  const participantLabel = fc.participants.singularLabel;
  for (let i = 0; i < children.length; i++) {
    const c = children[i];
    const missingForChild = [];
    if (pf.name.show && pf.name.required && !c.name) missingForChild.push(pf.name.label || (participantLabel + "'s Name"));
    if (pf.dob.show && pf.dob.required && !c.dob) missingForChild.push(pf.dob.label);
    if (pf.healthcare.show && pf.healthcare.required && !c.healthcare_provider) missingForChild.push(pf.healthcare.label);
    if (pf.allergies.show && pf.allergies.required && !c.allergies) missingForChild.push(pf.allergies.label);
    if (missingForChild.length > 0) {
      req.session.flash = { type: 'error', msg: `Please complete the following for ${participantLabel} ${i + 1}: ${missingForChild.join(', ')}.` };
      return res.redirect(303, regUrl);
    }
  }

  // Notes required (if configured)
  if (fc.notes.show && fc.notes.required && !notes) {
    req.session.flash = { type: 'error', msg: 'Please fill in the notes field.' };
    return res.redirect(303, regUrl);
  }

  // Custom questions: pair the program's questions (in order) with the user's submitted values.
  // Storing label+value snapshot keeps the wording with the registration even if the program edits its questions later.
  const programQuestions = (program && program.customQuestions) || [];
  const rawCustom = req.body.custom || {};
  const customResponses = programQuestions.map((q, i) => ({
    label: q.label,
    value: (rawCustom[i] || '').toString().trim(),
  }));
  const missingRequired = programQuestions
    .map((q, i) => ({ q, value: customResponses[i].value }))
    .filter(x => x.q.required && !x.value)
    .map(x => x.q.label);
  if (missingRequired.length > 0) {
    req.session.flash = { type: 'error', msg: 'Please answer the required question(s): ' + missingRequired.join(', ') + '.' };
    return res.redirect(303, regUrl);
  }

  // Compose confirmation email — defensive when fields were hidden by config.
  const dateListStr = dateList.sort().map(d => {
    const dt = new Date(d + 'T00:00:00');
    return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }).join('\n  ');

  const childNames = children.map(c => c.name).filter(Boolean);
  const childListStr = childNames.length === 0
    ? null
    : childNames.length === 1
      ? childNames[0]
      : childNames.slice(0, -1).join(', ') + ' and ' + childNames[childNames.length - 1];

  const programName = program ? program.name : 'our program';
  const greetingName = (fc.contactName.show && parent_name) || childListStr || 'Friend';
  const enrolledSubject = childListStr || 'your registration';

  const responsesBlock = customResponses.filter(r => r.value).length > 0
    ? '\n\nYour responses:\n' + customResponses.filter(r => r.value).map(r => `  • ${r.label}: ${r.value}`).join('\n')
    : '';

  const emailBody = `Dear ${greetingName},

Thank you for registering ${enrolledSubject} for ${programName}!

Enrolled dates:
  ${dateListStr}${responsesBlock}

If you have any questions, reply to this email or call us at ${site.phone}.

Warm regards,
${site.name} Team`;

  // Only persist fields that were collected per formConfig. Hidden fields → null.
  const recordedEmail = fc.contactEmail.show ? (parent_email || null) : null;
  const queueEmail = fc.contactEmail.show && recordedEmail; // skip queuing when no email
  try {
    await db.createRegistration({
      programId: program_id,
      parentName: fc.contactName.show ? (parent_name || null) : null,
      parentEmail: recordedEmail,
      parentPhone: fc.contactPhone.show ? (parent_phone || null) : null,
      notes: fc.notes.show ? (notes || null) : null,
      children: children.map(c => ({
        name: fc.participants.fields.name.show ? (c.name || null) : null,
        dob: fc.participants.fields.dob.show ? (c.dob || null) : null,
        healthcareProvider: fc.participants.fields.healthcare.show ? (c.healthcare_provider || null) : null,
        allergies: fc.participants.fields.allergies.show ? (c.allergies || null) : null,
      })),
      selectedDates: dateList,
      customResponses,
      // Pass an email subject/body only when we actually have an address to send to.
      emailSubject: queueEmail ? `Registration Confirmation — ${programName}` : null,
      emailBody: queueEmail ? emailBody : null,
      programName,
    });
    const successMsg = queueEmail
      ? 'Registration complete! You will receive a confirmation email shortly.'
      : 'Registration complete!';
    req.session.flash = { type: 'success', msg: successMsg };
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

router.post('/inquiry', publicFormLimiter, asyncHandler(async (req, res) => {
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
