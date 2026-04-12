const express = require('express');
const router = express.Router();
const db = require('../db/dynamo');

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.get('/', asyncHandler(async (req, res) => {
  const programs = await db.getAllPrograms();
  res.render('home', { programs });
}));

router.get('/register', asyncHandler(async (req, res) => {
  const programs = await db.getAllPrograms();
  const programId = req.query.program || null;
  res.render('register', { programs, selectedProgramId: programId });
}));

router.post('/register', asyncHandler(async (req, res) => {
  const {
    program_id, parent_name, parent_email, parent_phone,
    notes, selected_dates,
  } = req.body;

  const rawChildren = req.body.children || {};
  const children = Object.values(rawChildren).filter(c => c.name && c.dob);

  if (!program_id || !parent_name || !parent_email || !parent_phone ||
      children.length === 0 || !selected_dates) {
    req.session.flash = { type: 'error', msg: 'Please fill in all required fields, add at least one child, and select dates.' };
    return res.redirect(303, '/register?program=' + (program_id || ''));
  }

  // selected_dates are now date strings: "2026-06-15,2026-06-16,..."
  const dateList = selected_dates.split(',').map(d => d.trim()).filter(Boolean);
  if (dateList.length === 0) {
    req.session.flash = { type: 'error', msg: 'Please select at least one date.' };
    return res.redirect(303, '/register?program=' + program_id);
  }

  // Server-side validation
  const emailRe = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;
  const phoneDigits = parent_phone.replace(/\D/g, '');
  if (!emailRe.test(parent_email)) {
    req.session.flash = { type: 'error', msg: 'Please enter a valid email address.' };
    return res.redirect(303, '/register?program=' + program_id);
  }
  if (phoneDigits.length !== 10) {
    req.session.flash = { type: 'error', msg: 'Please enter a valid 10-digit phone number.' };
    return res.redirect(303, '/register?program=' + program_id);
  }

  const program = await db.getProgram(program_id);

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

If you have any questions, reply to this email or call us at 415-272-2241.

Warm regards,
World in Wonder Team`;

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
    req.session.flash = { type: 'error', msg: 'Something went wrong. Please try again.' };
    res.redirect(303, '/register?program=' + program_id);
  }
}));

router.get('/register/thanks', (req, res) => {
  res.render('thanks');
});

module.exports = router;
