(function () {
  const phoneInput = document.getElementById('parentPhone');
  const phoneError = document.getElementById('phoneError');
  const emailInput = document.getElementById('parentEmail');
  const emailError = document.getElementById('emailError');

  // --- Phone: auto-format to (XXX) XXX-XXXX ---

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

  // --- Email validation ---

  const emailPattern = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;

  emailInput.addEventListener('blur', validateEmail);
  emailInput.addEventListener('input', function () {
    if (emailPattern.test(this.value)) {
      this.classList.add('valid');
      this.classList.remove('invalid');
      emailError.textContent = '';
    } else if (this.classList.contains('invalid')) {
      validateEmail();
    }
  });

  function validateEmail() {
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

  // --- Full form validation on submit (no page reload) ---

  const form = document.getElementById('regForm');

  // Get or create a general error element at the top of the form
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

    // Program
    const program = document.getElementById('programSelect');
    if (!program.value) {
      errors.push('Please select a program.');
    }

    // Dates
    const selectedDates = document.getElementById('selectedDates');
    if (!selectedDates.value) {
      errors.push('Please select at least one date.');
    }

    // Parent name
    const parentName = form.querySelector('input[name="parent_name"]');
    if (!parentName.value.trim()) {
      errors.push('Parent/Guardian name is required.');
    }

    // Email
    const emailVal = emailInput.value.trim();
    if (!emailPattern.test(emailVal)) {
      emailInput.classList.add('invalid');
      emailError.textContent = 'Please enter a valid email address.';
      errors.push('Please enter a valid email address.');
    }

    // Phone
    const digits = phoneInput.value.replace(/\D/g, '');
    if (digits.length !== 10) {
      phoneInput.classList.add('invalid');
      phoneError.textContent = 'Please enter a complete 10-digit phone number.';
      errors.push('Please enter a valid 10-digit phone number.');
    }

    // At least one child with name and DOB
    const childNames = form.querySelectorAll('input[name$="[name]"]');
    const childDobs = form.querySelectorAll('input[name$="[dob]"]');
    let hasChild = false;
    childNames.forEach((nameInput, i) => {
      if (nameInput.value.trim() && childDobs[i] && childDobs[i].value) {
        hasChild = true;
      }
    });
    if (!hasChild) {
      errors.push('Please add at least one child with name and date of birth.');
    }

    if (errors.length > 0) {
      e.preventDefault();
      formError.innerHTML = errors.join('<br>');
      formError.style.display = 'block';
      formError.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });
})();
