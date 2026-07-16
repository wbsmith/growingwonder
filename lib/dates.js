// Date helpers pinned to the program's local timezone. The site operates in
// Marin County, CA, so "today" must be Pacific time (PST/PDT chosen
// automatically by Intl per the date) — not the server's UTC, which would flip
// the date mid-afternoon Pacific and hide/allow dates a day early.
const TIMEZONE = 'America/Los_Angeles';

// Today's date as a "YYYY-MM-DD" string in TIMEZONE. Comparable lexicographically
// against the "YYYY-MM-DD" date keys stored on wiw-dates rows.
function today() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const p = {};
  for (const { type, value } of parts) p[type] = value;
  return `${p.year}-${p.month}-${p.day}`;
}

module.exports = { TIMEZONE, today };
