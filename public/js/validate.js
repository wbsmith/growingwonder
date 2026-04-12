(function () {
  const phoneInput = document.getElementById('parentPhone');
  const phoneError = document.getElementById('phoneError');
  const emailInput = document.getElementById('parentEmail');
  const emailError = document.getElementById('emailError');

  // --- Phone: auto-format to (XXX) XXX-XXXX ---

  phoneInput.addEventListener('input', function () {
    // Strip to digits only
    const digits = this.value.replace(/\D/g, '').slice(0, 10);
    // Format as we go
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
    // Clear error while typing if it becomes valid
    if (emailPattern.test(this.value)) {
      this.classList.add('valid');
      this.classList.remove('invalid');
      emailError.textContent = '';
    } else if (this.classList.contains('invalid')) {
      // Re-check on each keystroke only if already flagged
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

  // --- Prevent submit if invalid ---

  const form = document.getElementById('regForm');
  form.addEventListener('submit', function (e) {
    const digits = phoneInput.value.replace(/\D/g, '');
    const emailVal = emailInput.value.trim();
    let hasError = false;

    if (digits.length !== 10) {
      phoneInput.classList.add('invalid');
      phoneError.textContent = 'Please enter a complete 10-digit phone number.';
      hasError = true;
    }
    if (!emailPattern.test(emailVal)) {
      emailInput.classList.add('invalid');
      emailError.textContent = 'Please enter a valid email address.';
      hasError = true;
    }

    if (hasError) {
      e.preventDefault();
      // Scroll to first error
      const firstInvalid = form.querySelector('.invalid');
      if (firstInvalid) firstInvalid.focus();
    }
  });
})();
