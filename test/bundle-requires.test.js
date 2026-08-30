// Guard against the class of bug that took prod down: server code that
// require()s a relative path into a directory Amplify does NOT copy into the
// compute bundle (.amplify-hosting/compute/default). Such a require resolves
// locally (the dir exists in the repo) but throws MODULE_NOT_FOUND in the Lambda,
// crashing the whole app at cold start. Concretely: routes/admin.js require()d
// ../public/js/inbox-render while amplify.yml copied only views/lib/routes/db.
//
// This test parses amplify.yml for the entries actually copied into the compute
// bundle and asserts every server-side `require('../<dir>/...')` targets one of
// them. Runs on Node's built-in runner with no external deps.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// Top-level entries copied into .amplify-hosting/compute/default by amplify.yml.
function bundledEntries() {
  const yml = fs.readFileSync(path.join(ROOT, 'amplify.yml'), 'utf8');
  const set = new Set();
  for (const m of yml.matchAll(/cp\s+(.+?)\s+\.amplify-hosting\/compute\/default\/?\s*$/gm)) {
    for (const tok of m[1].trim().split(/\s+/)) {
      if (tok === '-r' || tok === '-R') continue;
      set.add(tok.replace(/\/\*$/, '').replace(/\/$/, ''));
    }
  }
  return set;
}

function serverFiles() {
  const files = ['app.js', 'server.js'];
  for (const dir of ['routes', 'lib', 'db']) {
    for (const f of fs.readdirSync(path.join(ROOT, dir))) {
      if (f.endsWith('.js')) files.push(path.join(dir, f));
    }
  }
  return files;
}

test('server require("../<dir>/...") only targets dirs in the Amplify compute bundle', () => {
  const bundled = bundledEntries();
  // Sanity: parsing worked and picks up the known-copied dirs.
  for (const d of ['views', 'lib', 'routes', 'db']) {
    assert.ok(bundled.has(d), `amplify.yml parse failed to find '${d}' in compute copies`);
  }
  const offenders = [];
  for (const rel of serverFiles()) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const m of src.matchAll(/require\(\s*['"]\.\.\/([^'"\/]+)/g)) {
      const topDir = m[1];
      if (!bundled.has(topDir)) {
        offenders.push(`${rel}: require('../${topDir}/...') — '${topDir}' is NOT copied into the compute bundle by amplify.yml`);
      }
    }
  }
  assert.deepStrictEqual(offenders, [],
    'Server code requires a directory missing from the Amplify compute bundle ' +
    '(would MODULE_NOT_FOUND in Lambda):\n' + offenders.join('\n'));
});
