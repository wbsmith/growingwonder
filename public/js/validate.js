(function () {
  const phoneInput = document.getElementById('parentPhone');
  const phoneError = document.getElementById('phoneError');
  const emailInput = document.getElementById('parentEmail');
  const emailError = document.getElementById('emailError');

  const FALLBACK_FC = {
    contactName:  { show: true, required: true, label: 'Parent/Guardian Name' },
    contactEmail: { show: true, required: true, label: 'Email' },
    contactPhone: { show: true, required: true, label: 'Phone' },
    participants: {
      singularLabel: 'Child',
      fields: {
        name: { show: true, required: true, label: null },
        dob:  { show: true, required: true, label: 'Date of Birth' },
      },
    },
    notes: { show: true, required: false, label: 'Notes' },
    terms: { show: true, required: true },
  };
  function fc() { return window.currentProgramFormConfig || FALLBACK_FC; }

  const emailPattern = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;

  // --- Phone auto-format + live validation (only when shown) ---

  phoneInput.addEventListener('input', function () {
    const digits = this.value.replace(/\D/g, '').slice(0, 10);
    let formatted = '';
    if (digits.length > 0) formatted = '(' + digits.slice(0, 3);
    if (digits.length >= 3) formatted += ') ';
    if (digits.length > 3) formatted += digits.slice(3, 6);
    if (digits.length >= 6) formatted += '-';
    if (digits.length > 6) formatted += digits.slice(6, 10);
    this.value = formatted;
    validatePhone();
  });
  phoneInput.addEventListener('blur', validatePhone);

  function validatePhone() {
    if (!fc().contactPhone.show) {
      phoneInput.classList.remove('invalid', 'valid');
      phoneError.textContent = '';
      return;
    }
    const digits = phoneInput.value.replace(/\D/g, '');
    if (phoneInput.value === '') {
      phoneInput.classList.remove('invalid', 'valid');
      phoneError.textContent = '';
    } else if (digits.length < 10) {
      phoneInput.classList.add('invalid');
      phoneInput.classList.remove('valid');
      phoneError.textContent = 'Please enter a complete 10-digit phone number.';
    } else {
      phoneInput.classList.add('valid');
      phoneInput.classList.remove('invalid');
      phoneError.textContent = '';
    }
  }

  // --- Email live validation (only when shown) ---

  emailInput.addEventListener('blur', validateEmail);
  emailInput.addEventListener('input', function () {
    if (!fc().contactEmail.show) return;
    if (emailPattern.test(this.value)) {
      this.classList.add('valid');
      this.classList.remove('invalid');
      emailError.textContent = '';
    } else if (this.classList.contains('invalid')) {
      validateEmail();
    }
  });

  function validateEmail() {
    if (!fc().contactEmail.show) {
      emailInput.classList.remove('invalid', 'valid');
      emailError.textContent = '';
      return;
    }
    const val = emailInput.value.trim();
    if (val === '') {
      emailInput.classList.remove('invalid', 'valid');
      emailError.textContent = '';
    } else if (!emailPattern.test(val)) {
      emailInput.classList.add('invalid');
      emailInput.classList.remove('valid');
      emailError.textContent = 'Please enter a valid email address.';
    } else {
      emailInput.classList.add('valid');
      emailInput.classList.remove('invalid');
      emailError.textContent = '';
    }
  }

  // --- Submit-time validation, driven entirely by formConfig ---

  const form = document.getElementById('regForm');

  let formError = document.getElementById('formError');
  if (!formError) {
    formError = document.createElement('div');
    formError.id = 'formError';
    formError.style.cssText = 'display:none; background:#f8d7da; color:#721c24; padding:12px 16px; border-radius:8px; margin-bottom:16px; font-size:0.9rem;';
    form.insertBefore(formError, form.firstChild);
  }

  form.addEventListener('submit', function (e) {
    const errors = [];
    formError.style.display = 'none';
    const C = fc();

    // Program (always required — a registration is meaningless without one)
    const program = document.getElementById('programSelect');
    if (!program.value) errors.push('Please select a program.');

    // Dates (always required for now)
    const selectedDates = document.getElementById('selectedDates');
    if (!selectedDates.value) errors.push('Please select at least one date.');

    // Contact name
    if (C.contactName.show && C.contactName.required) {
      const parentName = form.querySelector('input[name="parent_name"]');
      if (!parentName.value.trim()) errors.push(C.contactName.label + ' is required.');
    }

    // Contact email — format-check whenever shown AND value present; required gates the empty case
    if (C.contactEmail.show) {
      const v = emailInput.value.trim();
      if (C.contactEmail.required && !v) {
        errors.push(C.contactEmail.label + ' is required.');
      } else if (v && !emailPattern.test(v)) {
        emailInput.classList.add('invalid');
        emailError.textContent = 'Please enter a valid email address.';
        errors.push('Please enter a valid email address.');
      }
    }

    // Contact phone — same pattern
    if (C.contactPhone.show) {
      const digits = phoneInput.value.replace(/\D/g, '');
      if (C.contactPhone.required && !digits) {
        errors.push(C.contactPhone.label + ' is required.');
      } else if (digits && digits.length !== 10) {
        phoneInput.classList.add('invalid');
        phoneError.textContent = 'Please enter a complete 10-digit phone number.';
        errors.push('Please enter a valid 10-digit phone number.');
      }
    }

    // Participants — at least one row must satisfy whichever participant fields are required.
    const pf = C.participants.fields;
    const singular = C.participants.singularLabel;
    const childRows = form.querySelectorAll('.child-entry');
    let satisfiedRow = false;
    childRows.forEach(row => {
      const fields = {
        name: row.querySelector('input[name$="[name]"]'),
        dob: row.querySelector('input[name$="[dob]"]'),
        healthcare: row.querySelector('input[name$="[healthcare_provider]"]'),
        allergies: row.querySelector('input[name$="[allergies]"]'),
      };
      const requiredOk = ['name', 'dob', 'healthcare', 'allergies'].every(k => {
        const cfg = pf[k];
        if (!cfg.show || !cfg.required) return true;
        return fields[k] && fields[k].value.trim();
      });
      // A row counts only if at least one shown field is filled.
      const anyFilled = ['name', 'dob', 'healthcare', 'allergies'].some(k => pf[k].show && fields[k] && fields[k].value.trim());
      if (requiredOk && anyFilled) satisfiedRow = true;
    });
    if (!satisfiedRow) {
      // Build a useful message based on what's required.
      const requiredLabels = [];
      if (pf.name.show && pf.name.required) requiredLabels.push(pf.name.label || (singular + "'s name"));
      if (pf.dob.show && pf.dob.required) requiredLabels.push(pf.dob.label);
      if (pf.healthcare.show && pf.healthcare.required) requiredLabels.push(pf.healthcare.label);
      if (pf.allergies.show && pf.allergies.required) requiredLabels.push(pf.allergies.label);
      const what = requiredLabels.length ? requiredLabels.join(' and ') : 'participant info';
      errors.push('Please add at least one ' + singular.toLowerCase() + ' with ' + what + '.');
    }

    // Notes
    if (C.notes.show && C.notes.required) {
      const notes = form.querySelector('textarea[name="notes"]');
      if (notes && !notes.value.trim()) errors.push((C.notes.label || 'Notes') + ' is required.');
    }

    // Custom questions — respect each question's required flag against its rendered input.
    form.querySelectorAll('#customQuestionsList [required]').forEach(input => {
      if (!input.value.trim()) {
        const label = input.closest('.form-group').querySelector('label');
        const qLabel = label ? label.firstChild.textContent.trim() : 'A required question';
        errors.push(qLabel + ' is required.');
      }
    });

    // Terms — only when shown AND required
    if (C.terms.show && C.terms.required) {
      const terms = document.getElementById('termsCheckbox');
      if (terms && !terms.checked) errors.push('Please agree to the terms and conditions.');
    }

    if (errors.length > 0) {
      e.preventDefault();
      formError.innerHTML = errors.join('<br>');
      formError.style.display = 'block';
      formError.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });
})();
