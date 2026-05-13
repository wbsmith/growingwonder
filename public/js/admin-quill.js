// Shared Quill setup for admin content editors. Provides a unified toolbar,
// font + size whitelists with inline-style output (so pasted content renders
// without depending on Quill's class-based CSS), an explicit "No background"
// option, and an HTML-source toggle as an opt-in feature.
//
// Load this AFTER the Quill CDN script:
//   <script src="https://cdn.jsdelivr.net/npm/quill@2/dist/quill.js"></script>
//   <script src="/js/admin-quill.js"></script>
//
// Then construct an editor with:
//   const q = createAdminQuill('#myEditor', { placeholder: '...', allowImage: true, allowHtmlToggle: true });
//   q.getCleanHtml()  // → editor HTML, with '<p><br></p>' normalized to ''

(function () {
  if (typeof Quill === 'undefined') return;

  // --- Attributor registration ---------------------------------------------

  const FONT_WHITELIST = ['Lato', 'Helvetica', 'Georgia', 'Playfair Display'];
  const SIZE_WHITELIST = ['12px', '14px', '16px', '18px', '20px', '24px', '32px'];

  const FontStyle = Quill.import('attributors/style/font');
  FontStyle.whitelist = FONT_WHITELIST;
  Quill.register(FontStyle, true);

  const SizeStyle = Quill.import('attributors/style/size');
  SizeStyle.whitelist = SIZE_WHITELIST;
  Quill.register(SizeStyle, true);

  // --- Background "None" -------------------------------------------------
  // First entry being `false` (rendered by Quill as a white/X "remove" swatch)
  // tells Quill to strip the background attribute on the current selection —
  // exactly the behavior needed when pasted content brings its own background.
  const BACKGROUND_COLORS = [
    false,
    '#ffffff', '#fafaf7', '#fff8dc', '#fffacd',
    '#ffeb3b', '#a5d6a7', '#90caf9', '#ffccbc',
    '#e1bee7', '#cfd8dc', '#f5f5f5', '#000000',
  ];

  // --- Toolbar builder ----------------------------------------------------

  function buildToolbar(opts) {
    const last = ['clean'];
    if (opts.allowHtmlToggle) last.push('html-toggle');
    return [
      [{ header: [2, 3, false] }, { font: FONT_WHITELIST }, { size: SIZE_WHITELIST }],
      ['bold', 'italic', 'underline'],
      [{ color: [] }, { background: BACKGROUND_COLORS }],
      [{ align: [] }, { align: 'center' }, { align: 'right' }],
      [{ list: 'ordered' }, { list: 'bullet' }],
      opts.allowImage ? ['link', 'image'] : ['link'],
      last,
    ];
  }

  // --- HTML source toggle -------------------------------------------------

  function attachHtmlToggle(q) {
    const toolbarEl = q.container.previousElementSibling;
    if (!toolbarEl) return;
    const btn = toolbarEl.querySelector('.ql-html-toggle');
    if (!btn) return;
    btn.innerHTML = '&lt;/&gt;';
    btn.title = 'Edit HTML source';

    let htmlMode = false;
    let htmlTextarea = null;

    btn.addEventListener('click', function () {
      if (!htmlMode) {
        htmlTextarea = document.createElement('textarea');
        htmlTextarea.style.cssText =
          'width:100%; min-height:240px; padding:12px; font-family:monospace; font-size:0.85rem; ' +
          'border:1px solid #ccc; border-radius:0 0 var(--radius) var(--radius);';
        htmlTextarea.value = q.root.innerHTML;
        q.container.style.display = 'none';
        q.container.parentNode.insertBefore(htmlTextarea, q.container.nextSibling);
        btn.style.background = '#e8f5e9';
      } else {
        q.root.innerHTML = htmlTextarea.value;
        htmlTextarea.remove();
        htmlTextarea = null;
        q.container.style.display = '';
        btn.style.background = '';
      }
      htmlMode = !htmlMode;
    });

    // Override the html getter so callers always see the latest content,
    // whether they're in rich-text mode or HTML-source mode.
    q._htmlSync = function () {
      if (htmlMode && htmlTextarea) q.root.innerHTML = htmlTextarea.value;
    };
  }

  // --- Public factory -----------------------------------------------------

  window.createAdminQuill = function (selector, opts) {
    opts = opts || {};
    const q = new Quill(selector, {
      theme: 'snow',
      modules: { toolbar: { container: buildToolbar(opts) } },
      placeholder: opts.placeholder || '',
    });

    if (opts.allowHtmlToggle) attachHtmlToggle(q);

    q.getCleanHtml = function () {
      if (typeof q._htmlSync === 'function') q._htmlSync();
      const html = q.root.innerHTML;
      return html === '<p><br></p>' ? '' : html;
    };
    return q;
  };
})();
