// Shared inbox thread-row renderer.
//
// Isomorphic on purpose: the browser loads it as a global (`window.renderThreadRow`)
// for the no-reload feed poll, and routes/admin.js `require()`s the very same file
// to render the initial server-side rows — so the two renders can't drift. Keep it
// dependency-free (no DOM APIs, no Node APIs); it only builds an HTML string from a
// plain thread object (the shape returned by lib/threads.buildThreads).
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) { root.renderThreadRow = api.renderThreadRow; root.inboxRowSig = api.inboxRowSig; }
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : null), function () {
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // A compact signature of just the fields that affect how a row looks. Stored on
  // the <tr data-sig> so the poll can skip re-rendering unchanged rows — important
  // because the CSRF injector mutates each form after insertion, which would make a
  // raw outerHTML diff always report "changed".
  function inboxRowSig(t) {
    return [t.unreadCount, t.latestStatus, t.latestDirection, t.messageCount,
      t.latestDate, t.subject, t.latestSnippet, t.toAddr, t.parentName, t.childName,
      t.isRegistration ? 1 : 0, t.archived ? 1 : 0, (t.messageIds || []).join('|')].join('␟');
  }

  function renderThreadRow(t) {
    var href = t.registrationId
      ? '/admin/messages/thread/' + encodeURIComponent(t.registrationId)
      : '/admin/messages/thread/addr/' + encodeURIComponent(t.addr);
    var ids = (t.messageIds || []).join(',');
    var unread = t.unreadCount > 0;
    var rowStyle = unread ? 'font-weight:600; background:#f4f8f3;' : '';

    var statusCell = '';
    if (unread) statusCell += '<span title="' + esc(t.unreadCount + ' unread') + '" style="display:inline-block; width:9px; height:9px; border-radius:50%; background:var(--green-mid); vertical-align:middle;"></span>';
    if (t.latestStatus === 'draft') statusCell += '<span class="badge badge-draft">draft</span>';
    else if (t.latestStatus === 'failed') statusCell += '<span class="badge badge-failed">failed</span>';
    if (t.archived) statusCell += ' <span class="badge" style="background:#e9ecef; color:#555;">archived</span>';

    var nameLine = t.parentName
      ? '<div style="font-size:0.78rem; color:var(--text-light); font-weight:normal;">' + esc(t.parentName) + (t.childName ? ' &middot; ' + esc(t.childName) : '') + '</div>'
      : '';

    var confBadge = t.isRegistration
      ? ' <span style="display:inline-block; font-size:0.7rem; font-weight:700; padding:1px 6px; border-radius:8px; color:var(--green-dark); border:1px solid var(--green-mid); vertical-align:middle;">Confirmation</span>'
      : '';

    var snippet = t.latestSnippet
      ? '<div style="font-size:0.78rem; color:var(--text-light); font-weight:normal; max-width:340px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + (t.latestDirection === 'in' ? '↩ ' : '') + esc(t.latestSnippet) + '</div>'
      : '';

    var countCell = t.messageCount > 1
      ? '<span style="background: var(--green-dark); color: white; border-radius: 10px; padding: 1px 7px; font-size: 0.75rem; font-weight: 600;">' + esc(t.messageCount) + '</span>'
      : '1';

    var openLabel = t.latestStatus === 'draft' ? 'Open' : (t.messageCount > 1 ? 'View Thread' : 'View');

    var archiveForm = t.archived
      ? '<form method="POST" action="/admin/messages/unarchive" style="display:inline; margin-left:4px;">' +
          '<input type="hidden" name="item_ids" value="' + esc(ids) + '">' +
          '<button type="submit" title="Unarchive" style="background:none;border:none;color:var(--green-mid);cursor:pointer;font-size:1rem;padding:2px 4px;vertical-align:middle;">&#x21ba;</button></form>'
      : '<form method="POST" action="/admin/messages/archive" style="display:inline; margin-left:4px;">' +
          '<input type="hidden" name="item_ids" value="' + esc(ids) + '">' +
          '<button type="submit" title="Archive" style="background:none;border:none;color:var(--text-light);cursor:pointer;font-size:1rem;padding:2px 4px;vertical-align:middle;">&#x1F4E5;</button></form>';

    var delMsg = t.messageCount > 1 ? 'Delete all ' + t.messageCount + ' messages in this thread?' : 'Delete this message?';
    var deleteForm = '<form method="POST" action="/admin/messages/delete" style="display:inline; margin-left: 4px;">' +
      '<input type="hidden" name="type" value="email">' +
      '<input type="hidden" name="item_id" value="' + esc(ids) + '">' +
      '<button type="submit" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:1rem;padding:2px 4px;vertical-align:middle;" title="Delete" ' +
      'onclick="return confirm(\'' + delMsg + '\')">&#x1F5D1;</button></form>';

    return '<tr data-thread-key="' + esc(t.key) + '" data-sig="' + esc(inboxRowSig(t)) + '" style="' + rowStyle + '">' +
      '<td style="white-space:nowrap;">' + statusCell + '</td>' +
      '<td><div>' + esc(t.toAddr) + '</div>' + nameLine + '</td>' +
      '<td><div>' + esc(t.subject) + confBadge + '</div>' + snippet + '</td>' +
      '<td style="text-align: center;">' + countCell + '</td>' +
      '<td style="font-size: 0.8rem;">' + esc(t.latestDate) + '</td>' +
      '<td style="white-space:nowrap;">' +
        '<a href="' + href + '" class="btn btn-outline btn-sm">' + openLabel + '</a>' +
        archiveForm + deleteForm +
      '</td></tr>';
  }

  return { renderThreadRow: renderThreadRow, inboxRowSig: inboxRowSig };
});
