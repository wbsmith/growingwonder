// Regression guard for lib/sanitize.js — the HTML sanitizer applied to outbound
// message bodies rendered raw in the admin thread view. Ensures active-content
// vectors are stripped while legitimate Quill formatting survives.
const { test } = require('node:test');
const assert = require('node:assert');
const { sanitizeMessageHtml } = require('../lib/sanitize');

test('strips <script>, on* handlers, javascript: URLs, and <iframe>', () => {
  const out = sanitizeMessageHtml(
    '<p>hi <b>there</b></p><script>alert(1)</script>' +
    '<img src=x onerror=alert(2)><a href="javascript:alert(3)">x</a><iframe src=evil></iframe>');
  assert.ok(!/<script/i.test(out), 'no <script>');
  assert.ok(!/onerror/i.test(out), 'no event handlers');
  assert.ok(!/javascript:/i.test(out), 'no javascript: URL');
  assert.ok(!/<iframe/i.test(out), 'no <iframe>');
  assert.match(out, /<b>there<\/b>/, 'keeps bold');
  assert.match(out, /<p>/, 'keeps paragraph');
});

test('keeps safe formatting: links, data-URI images, safe inline styles', () => {
  const out = sanitizeMessageHtml(
    '<p style="text-align:center;color:#f00">Hi <a href="https://x.com">L</a> ' +
    '<img src="data:image/png;base64,AAA" alt="e"></p>');
  assert.match(out, /href="https:\/\/x\.com"/, 'keeps https link');
  assert.match(out, /data:image\/png/, 'keeps data-URI image');
  assert.match(out, /text-align:center/, 'keeps safe style');
  assert.match(out, /rel="noopener noreferrer"/, 'hardens external links');
});

test('drops dangerous style properties (background-image url)', () => {
  const out = sanitizeMessageHtml('<p style="background-image:url(javascript:alert(1));color:red">x</p>');
  assert.ok(!/background-image/i.test(out), 'drops background-image');
  assert.ok(!/javascript:/i.test(out), 'no javascript: in style');
});

test('empty / nullish input returns empty string', () => {
  assert.strictEqual(sanitizeMessageHtml(''), '');
  assert.strictEqual(sanitizeMessageHtml(null), '');
  assert.strictEqual(sanitizeMessageHtml(undefined), '');
});
