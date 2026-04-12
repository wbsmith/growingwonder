(function () {
  const section = document.getElementById('childrenSection');
  const addBtn = document.getElementById('addChildBtn');
  const notesLabel = document.getElementById('notesLabel');
  let count = 1;

  function updateNotesLabel() {
    const names = Array.from(section.querySelectorAll('input[name$="[name]"]'))
      .map(el => el.value.trim().split(/\s+/)[0]) // first name only
      .filter(Boolean);

    if (names.length === 0) {
      notesLabel.textContent = 'Tell us a little something about your child';
    } else if (names.length === 1) {
      notesLabel.textContent = 'Tell us a little something about ' + names[0];
    } else if (names.length === 2) {
      notesLabel.textContent = 'Tell us a little something about ' + names[0] + ' & ' + names[1];
    } else {
      const last = names.pop();
      notesLabel.textContent = 'Tell us a little something about ' + names.join(', ') + ', & ' + last;
    }
  }

  // Listen for name input changes on the whole section (covers dynamic entries)
  section.addEventListener('input', function (e) {
    if (e.target.name && e.target.name.endsWith('[name]')) {
      updateNotesLabel();
    }
  });

  addBtn.addEventListener('click', function (e) {
    e.preventDefault();
    const idx = count++;
    const entry = document.createElement('div');
    entry.className = 'child-entry';
    entry.dataset.index = idx;
    entry.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 16px; margin-bottom: 8px;">
        <strong style="color: var(--green-dark);">Child ${idx + 1}</strong>
        <a href="#" class="remove-child" style="color: var(--red); font-size: 0.85rem;">Remove</a>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Child's Name <span class="req">*</span></label>
          <input type="text" name="children[${idx}][name]" required>
        </div>
        <div class="form-group">
          <label>Date of Birth <span class="req">*</span></label>
          <input type="date" name="children[${idx}][dob]" required>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Healthcare Provider</label>
          <input type="text" name="children[${idx}][healthcare_provider]">
        </div>
        <div class="form-group">
          <label>Allergies</label>
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
