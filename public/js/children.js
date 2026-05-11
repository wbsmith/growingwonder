(function () {
  const section = document.getElementById('childrenSection');
  const addBtn = document.getElementById('addChildBtn');
  const notesLabel = document.getElementById('notesLabel');
  let count = 1;

  const FALLBACK_FC = {
    participants: {
      singularLabel: 'Child',
      fields: {
        name: { show: true, required: true, label: null },
        dob: { show: true, required: true, label: 'Date of Birth' },
        healthcare: { show: true, required: false, label: 'Healthcare Provider' },
        allergies: { show: true, required: false, label: 'Allergies' },
      },
    },
    notes: { show: true, required: false, label: 'Tell us a little something about your child' },
  };

  function fc() { return window.currentProgramFormConfig || FALLBACK_FC; }
  function reqStar(f) { return f.required ? ' <span class="req">*</span>' : ''; }
  function reqAttr(f) { return f.required ? ' required' : ''; }
  function vis(f) { return f.show ? '' : 'display: none;'; }

  function updateNotesLabel() {
    const names = Array.from(section.querySelectorAll('input[name$="[name]"]'))
      .map(el => el.value.trim().split(/\s+/)[0])
      .filter(Boolean);
    const conf = fc().notes;
    if (names.length === 0) {
      notesLabel.innerHTML = conf.label + (conf.required ? ' <span class="req">*</span>' : '');
    } else if (names.length === 1) {
      notesLabel.textContent = 'Tell us a little something about ' + names[0];
    } else if (names.length === 2) {
      notesLabel.textContent = 'Tell us a little something about ' + names[0] + ' & ' + names[1];
    } else {
      const last = names.pop();
      notesLabel.textContent = 'Tell us a little something about ' + names.join(', ') + ', & ' + last;
    }
  }
  window.updateNotesLabel = updateNotesLabel;

  section.addEventListener('input', function (e) {
    if (e.target.name && e.target.name.endsWith('[name]')) {
      updateNotesLabel();
    }
  });

  addBtn.addEventListener('click', function (e) {
    e.preventDefault();
    const idx = count++;
    const C = fc();
    const F = C.participants.fields;
    const singular = C.participants.singularLabel;
    const nameLabel = F.name.label || (singular + "'s Name");
    const entry = document.createElement('div');
    entry.className = 'child-entry';
    entry.dataset.index = idx;
    entry.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 16px; margin-bottom: 8px;">
        <strong style="color: var(--green-dark);">${singular} ${idx + 1}</strong>
        <a href="#" class="remove-child" style="color: var(--red); font-size: 0.85rem;">Remove</a>
      </div>
      <div class="form-row">
        <div class="form-group" data-pfield="name" style="${vis(F.name)}">
          <label class="participant-name-label">${nameLabel}${reqStar(F.name)}</label>
          <input type="text" name="children[${idx}][name]"${reqAttr(F.name)}>
        </div>
        <div class="form-group" data-pfield="dob" style="${vis(F.dob)}">
          <label class="dob-label">${F.dob.label}${reqStar(F.dob)}</label>
          <input type="date" name="children[${idx}][dob]"${reqAttr(F.dob)}>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group" data-pfield="healthcare" style="${vis(F.healthcare)}">
          <label class="healthcare-label">${F.healthcare.label}${reqStar(F.healthcare)}</label>
          <input type="text" name="children[${idx}][healthcare_provider]"${reqAttr(F.healthcare)}>
        </div>
        <div class="form-group" data-pfield="allergies" style="${vis(F.allergies)}">
          <label class="allergies-label">${F.allergies.label}${reqStar(F.allergies)}</label>
          <input type="text" name="children[${idx}][allergies]"${reqAttr(F.allergies)}>
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
