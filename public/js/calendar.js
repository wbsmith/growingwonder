/**
 * Multi-select calendar for registration.
 *
 * Layout: leftmost "Full Week" column + day columns.
 *
 * If all available dates are weekdays, renders Mon–Fri only (no Sat/Sun clutter).
 * If any weekend dates exist, renders full Sun–Sat.
 *
 * Weeks that span two months share a single "Full Week" toggle — clicking it on
 * either month's row selects all days in that calendar week.
 */

(function () {
  const programSelect = document.getElementById('programSelect');
  const calendarEl = document.getElementById('calendar');
  const summaryEl = document.getElementById('selectedSummary');
  const countEl = document.getElementById('selectedCount');
  const listEl = document.getElementById('selectedList');
  const hiddenInput = document.getElementById('selectedDates');
  const hintEl = document.getElementById('calendarHint');

  const selected = new Set();
  let dateMap = {};

  const ALL_DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];

  programSelect.addEventListener('change', loadDates);
  if (programSelect.value) loadDates();

  // Week key = the Sunday's YYYY-MM-DD for the week containing dateStr.
  function weekKey(dateStr) {
    const dt = new Date(dateStr + 'T00:00:00');
    const sun = new Date(dt);
    sun.setDate(sun.getDate() - dt.getDay());
    return sun.toISOString().slice(0, 10);
  }

  async function loadDates() {
    const pid = programSelect.value;
    calendarEl.innerHTML = '';
    selected.clear();
    updateSummary();
    hintEl.textContent = '';
    if (!pid) return;

    const res = await fetch('/api/dates/' + pid);
    const dates = await res.json();
    if (dates.length === 0) {
      calendarEl.innerHTML = '<p style="color: var(--text-light);">No dates available for this program yet.</p>';
      return;
    }

    dateMap = {};
    dates.forEach(d => { dateMap[d.date] = d; });

    // Detect whether any dates fall on Sat or Sun
    const hasWeekend = dates.some(d => {
      const dow = new Date(d.date + 'T00:00:00').getDay();
      return dow === 0 || dow === 6;
    });

    // Visible columns: either Mon–Fri [1,2,3,4,5] or Sun–Sat [0,1,2,3,4,5,6]
    const visibleDows = hasWeekend ? [0, 1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5];
    const dayNames = visibleDows.map(i => ALL_DAY_NAMES[i]);
    // Map from dow → column index (or -1 if hidden)
    const dowToCol = new Array(7).fill(-1);
    visibleDows.forEach((dow, col) => { dowToCol[dow] = col; });
    const numCols = visibleDows.length;

    // Global week map: weekKey -> [dateId, ...]
    const weekMap = {};
    dates.forEach(d => {
      if (d.available <= 0) return;
      const wk = weekKey(d.date);
      if (!weekMap[wk]) weekMap[wk] = [];
      weekMap[wk].push(d.date);
    });

    // Set hint text based on whether any week has 2+ days
    const hasFullWeeks = Object.values(weekMap).some(ids => ids.length >= 2);
    hintEl.textContent = hasFullWeeks
      ? 'Click individual days or click a week row to select the entire week.'
      : 'Click individual days to select.';

    // Group by year-month
    const months = {};
    dates.forEach(d => {
      const key = d.date.slice(0, 7);
      if (!months[key]) months[key] = [];
      months[key].push(d);
    });

    Object.keys(months).sort().forEach(monthKey => {
      renderMonth(monthKey, months[monthKey], weekMap, visibleDows, dayNames, dowToCol, numCols);
    });
  }

  function renderMonth(monthKey, availableDates, weekMap, visibleDows, dayNames, dowToCol, numCols) {
    const [year, month] = monthKey.split('-').map(Number);
    const daysInMonth = new Date(year, month, 0).getDate();
    const startDow = new Date(year, month - 1, 1).getDay();

    const dayLookup = {};
    availableDates.forEach(d => {
      const dom = parseInt(d.date.split('-')[2], 10);
      dayLookup[dom] = d;
    });

    // --- Pass 1: Build row data ---
    // A "row" = one calendar week. Each row has `numCols` cell slots.
    const rows = [];
    let currentRow = null;
    let lastRowStart = null; // dow of the first visible column in this row's week

    function newRow() {
      if (currentRow) rows.push(currentRow);
      currentRow = { cells: new Array(numCols).fill(null), weekSunday: null };
    }

    for (let d = 1; d <= daysInMonth; d++) {
      const dow = (startDow + d - 1) % 7;
      const col = dowToCol[dow];

      // Skip days that aren't in visible columns
      if (col === -1) continue;

      // Start a new row when we hit the first visible day-of-week
      if (col === 0 || currentRow === null) {
        newRow();
      }

      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      if (!currentRow.weekSunday) {
        currentRow.weekSunday = weekKey(dateStr);
      }

      const avail = dayLookup[d] || null;
      currentRow.cells[col] = { dom: d, avail };
    }
    if (currentRow) rows.push(currentRow);

    // --- Pass 2: Render ---
    const monthDiv = document.createElement('div');
    monthDiv.className = 'calendar-month';

    const title = document.createElement('h4');
    title.textContent = MONTH_NAMES[month - 1] + ' ' + year;
    monthDiv.appendChild(title);

    const grid = document.createElement('div');
    grid.className = 'calendar-grid';
    grid.style.gridTemplateColumns = 'auto repeat(' + numCols + ', 1fr)';

    // Header row
    const weekHdr = document.createElement('div');
    weekHdr.className = 'day-header week-col-header';
    weekHdr.textContent = '';
    grid.appendChild(weekHdr);
    dayNames.forEach(n => {
      const hdr = document.createElement('div');
      hdr.className = 'day-header';
      hdr.textContent = n;
      grid.appendChild(hdr);
    });

    rows.forEach(row => {
      const fullWeekIds = row.weekSunday ? (weekMap[row.weekSunday] || []) : [];

      // Week toggle (leftmost)
      const toggle = document.createElement('div');
      toggle.className = 'day-cell';
      if (fullWeekIds.length >= 2) {
        toggle.classList.add('week-toggle');
        toggle.textContent = 'Full Week';
        toggle._dateIds = fullWeekIds;
        toggle.addEventListener('click', () => {
          const allSel = fullWeekIds.every(id => selected.has(id));
          fullWeekIds.forEach(id => {
            if (allSel) selected.delete(id);
            else selected.add(id);
          });
          refreshAllCells();
          updateSummary();
        });
      } else {
        toggle.classList.add('empty');
      }
      grid.appendChild(toggle);

      // Day cells
      for (let col = 0; col < numCols; col++) {
        const c = row.cells[col];
        const cell = document.createElement('div');
        cell.className = 'day-cell';
        if (!c) {
          cell.classList.add('empty');
        } else {
          cell.textContent = c.dom;
          if (c.avail) {
            if (c.avail.available <= 0) {
              cell.classList.add('full');
              cell.textContent = c.dom + ' Full';
              cell.title = 'This date is full';
            } else {
              cell.classList.add('available');
              cell.style.background = '#ffffff';
              cell.title = `${c.avail.available} of ${c.avail.capacity} spots`;
              cell.dataset.dateId = c.avail.date;
              cell.addEventListener('click', () => {
                toggleDate(c.avail.date);
                refreshAllCells();
                updateSummary();
              });
            }
          } else {
            cell.classList.add('unavailable');
          }
        }
        grid.appendChild(cell);
      }
    });

    monthDiv.appendChild(grid);
    calendarEl.appendChild(monthDiv);
  }

  function toggleDate(id) {
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
  }

  function refreshAllCells() {
    calendarEl.querySelectorAll('.day-cell.available').forEach(cell => {
      const id = cell.dataset.dateId;
      const isSel = selected.has(id);
      cell.classList.toggle('selected', isSel);
      cell.style.background = isSel ? '#2c4a2e' : '#ffffff';
      cell.style.color = isSel ? '#ffffff' : '#2c4a2e';
    });
    calendarEl.querySelectorAll('.week-toggle').forEach(cell => {
      const ids = cell._dateIds;
      if (!ids) return;
      const allSelected = ids.every(id => selected.has(id));
      cell.classList.toggle('all-selected', allSelected);
      cell.textContent = allSelected ? 'Selected' : 'Full Week';
    });
  }

  function updateSummary() {
    const ids = Array.from(selected);
    hiddenInput.value = ids.join(',');
    if (ids.length === 0) {
      summaryEl.style.display = 'none';
      return;
    }
    summaryEl.style.display = 'block';
    countEl.textContent = ids.length;

    const dates = ids
      .map(id => dateMap[id])
      .filter(Boolean)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(d => {
        const dt = new Date(d.date + 'T00:00:00');
        return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      });
    listEl.textContent = dates.join(', ');
  }
})();
