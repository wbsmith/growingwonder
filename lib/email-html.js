// Normalizes rich-text-editor HTML into email-safe markup.
//
// WHY THIS EXISTS
// ---------------
// The admin editors (Quill) emit a raw HTML *fragment* — a bare run of <p>,
// <h2>, <li>, <img>, etc. — and the mailer sends it with no surrounding
// document or styles. That leaves every mail client free to apply its own
// defaults, which produces two visible problems:
//
//   1. EXCESSIVE SPACING. Hard-wrapped text becomes one <p> per line, and
//      clients add a large default margin (~1em top+bottom) to every <p>.
//      Result: everything looks double-spaced.
//
//   2. GIANT EMOJI. Emoji pasted from other tools often arrive as <img> tags
//      (Twemoji/PNG, ~72px intrinsic) with no width/height. With nothing
//      constraining them, they render at full size next to normal-size text.
//
// Both are fixed here, before the HTML reaches SES, by:
//   - wrapping the body in a container with an explicit font / size /
//     line-height (so emoji glyphs and text share one predictable size), and
//   - rewriting block tags + dimensionless images with INLINE styles (inline
//     because Gmail and many clients strip <style> blocks).
//
// HOW TO TUNE IT
// --------------
// Everything you'd want to change lives in EMAIL_STYLE below. Want paragraphs
// spaced apart automatically? Set `paragraphMargin: '0 0 12px'`. Want tighter
// or looser text? Change `lineHeight`. Want bigger/smaller emoji? Change
// `emojiHeight`. No other file needs editing.

const EMAIL_STYLE = {
  // Base typography for the whole message. Emoji glyphs inherit `fontSize`,
  // so this is also the lever for unicode-emoji size.
  fontFamily: "-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  fontSize: '15px',
  lineHeight: '1.4',
  color: '#222222',

  // Space around each paragraph. '0' = single-spaced: the blank lines you
  // type (empty paragraphs) provide the gaps between paragraphs, matching how
  // the text reads in the editor. Use e.g. '0 0 12px' to auto-space instead.
  paragraphMargin: '0',

  // Headings (Quill emits <h2>/<h3>).
  headingMargin: '0.6em 0 0.2em',

  // List layout (keep some left padding or bullets/numbers disappear).
  listPadding: '1.4em',

  // Forced size for emoji that arrive as <img> (and any other dimensionless
  // inline image). Expressed relative to text size so it always matches.
  emojiHeight: '1.2em',
};

// Per-tag inline style injected on top of whatever the editor already set
// (alignment, color, font, size are preserved — we only add margins/layout).
const TAG_STYLE = {
  p: `margin:${EMAIL_STYLE.paragraphMargin};`,
  h2: `margin:${EMAIL_STYLE.headingMargin};`,
  h3: `margin:${EMAIL_STYLE.headingMargin};`,
  li: 'margin:0;',
  ul: `margin:0;padding:0 0 0 ${EMAIL_STYLE.listPadding};`,
  ol: `margin:0;padding:0 0 0 ${EMAIL_STYLE.listPadding};`,
};

// Merge a chunk of CSS into a tag's existing style="" (or add the attribute).
// `prepend` puts our CSS first so the editor's own declarations win on conflict.
function addStyle(openTag, css, prepend) {
  const m = openTag.match(/\sstyle\s*=\s*"([^"]*)"/i);
  if (m) {
    const merged = prepend ? css + m[1] : m[1] + ';' + css;
    return openTag.replace(m[0], ` style="${merged}"`);
  }
  return openTag.replace(/>$/, ` style="${css}">`);
}

function styleBlockTags(html) {
  let out = html;
  for (const [tag, css] of Object.entries(TAG_STYLE)) {
    const open = new RegExp(`<${tag}\\b[^>]*>`, 'gi');
    out = out.replace(open, (t) => addStyle(t, css, true));
  }
  return out;
}

// Shrink dimensionless inline images (overwhelmingly pasted emoji). Images that
// carry an explicit width/height — i.e. ones the author sized on purpose — are
// left untouched.
function styleImages(html) {
  const css = `height:${EMAIL_STYLE.emojiHeight};width:auto;vertical-align:middle;`;
  return html.replace(/<img\b[^>]*>/gi, (img) => {
    const hasDims =
      /\s(?:width|height)\s*=/i.test(img) ||
      /style\s*=\s*"[^"]*\b(?:width|height)\s*:/i.test(img);
    return hasDims ? img : addStyle(img, css, true);
  });
}

// Public: turn an editor HTML fragment into an email-safe, self-styled block.
// Returns the input unchanged if it's empty/whitespace.
function normalizeEmailHtml(fragment) {
  if (!fragment || !fragment.trim()) return fragment;
  const s = EMAIL_STYLE;
  const body = styleImages(styleBlockTags(fragment));
  return (
    `<div style="font-family:${s.fontFamily};font-size:${s.fontSize};` +
    `line-height:${s.lineHeight};color:${s.color};">${body}</div>`
  );
}

module.exports = { normalizeEmailHtml, EMAIL_STYLE };
