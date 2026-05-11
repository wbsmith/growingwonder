(function () {
  const section = document.getElementById('childrenSection');
  const addBtn = document.getElementById('addChildBtn');
  const notesLabel = document.getElementById('notesLabel');
  let count = 1;

  function labels() {
    return window.currentProgramLabels || {
      participantSingularLabel: 'Child',
      notesPrompt: 'Tell us a little something about your child',
      dobLabel: 'Date of Birth',
      healthcareLabel: 'Healthcare Provider',
      allergiesLabel: 'Allergies',
    };
  }

  function updateNotesLabel() {
    const names = Array.from(section.querySelectorAll('input[name$="[name]"]'))
      .map(el => el.value.trim().split(/\s+/)[0]) // first name only
      .filter(Boolean);

    if (names.length === 0) {
      notesLabel.textContent = labels().notesPrompt;
    } else if (names.length === 1) {
      notesLabel.textContent = 'Tell us a little something about ' + names[0];
    } else if (names.length === 2) {
      notesLabel.textContent = 'Tell us a little something about ' + names[0] + ' & ' + names[1];
    } else {
      const last = names.pop();
      notesLabel.textContent = 'Tell us a little something about ' + names.join(', ') + ', & ' + last;
    }
  }
  // Expose so the program-select handler can re-run after labels change.
  window.updateNotesLabel = updateNotesLabel;

  // Listen for name input changes on the whole section (covers dynamic entries)
  section.addEventListener('input', function (e) {
    if (e.target.name && e.target.name.endsWith('[name]')) {
      updateNotesLabel();
    }
  });

  addBtn.addEventListener('click', function (e) {
    e.preventDefault();
    const idx = count++;
    const L = labels();
    const singular = L.participantSingularLabel;
    const entry = document.createElement('div');
    entry.className = 'child-entry';
    entry.dataset.index = idx;
    entry.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 16px; margin-bottom: 8px;">
        <strong style="color: var(--green-dark);">${singular} ${idx + 1}</strong>
        <a href="#" class="remove-child" style="color: var(--red); font-size: 0.85rem;">Remove</a>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="participant-name-label">${singular}'s Name <span class="req">*</span></label>
          <input type="text" name="children[${idx}][name]" required>
        </div>
        <div class="form-group">
          <label class="dob-label">${L.dobLabel} <span class="req">*</span></label>
          <input type="date" name="children[${idx}][dob]" required>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="healthcare-label">${L.healthcareLabel}</label>
          <input type="text" name="children[${idx}][healthcare_provider]">
        </div>
        <div class="form-group">
          <label class="allergies-label">${L.allergiesLabel}</label>
          <input type="text" name="children[${idx}][allergies]">
        </div>
      </div>
    `;
    entry.querySelector('.remove-child').addEventListener('click', function (e2) {
      e2.preventDefault();
      entry.remove();
      updateNotesLabel();
    });
    section.appendChild(entry);
    updateNotesLabel();
  });
})();
