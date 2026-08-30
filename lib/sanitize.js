// HTML sanitization for stored message bodies that are rendered raw in the admin
// (the thread view, and future compose/outbox previews). Outbound bodies are
// admin-authored (Quill) today — so the immediate risk is self-XSS — but any
// message HTML rendered with EJS `<%- %>` MUST pass through here, and it becomes
// load-bearing the moment inbound HTML is ever shown. Strips <script>, event
// handlers (on*), javascript:/data: URLs on links, <iframe>/<object>/<form>, etc.
const sanitizeHtml = require('sanitize-html');

// Allowlist tuned to what the Quill editor emits, plus safe inline styling.
const OPTIONS = {
  allowedTags: [
    'p', 'br', 'div', 'span', 'strong', 'b', 'em', 'i', 'u', 's', 'strike',
    'a', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'img', 'hr', 'sub', 'sup', 'small',
  ],
  allowedAttributes: {
    a: ['href', 'name', 'target', 'rel'],
    img: ['src', 'alt', 'width', 'height', 'style'],
    '*': ['style', 'class'],
  },
  // Links: only web/mail/tel schemes (blocks javascript:). Images: web + data:
  // (Quill/pasted emoji use data URIs); data: on <img> can't execute script.
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesByTag: { img: ['http', 'https', 'data'] },
  allowProtocolRelative: false,
  // Keep a safe subset of inline styles; anything else (behavior, expression,
  // background-image:url(...), etc.) is dropped. Values are validated by regex.
  allowedStyles: {
    '*': {
      color: [/^[^;{}()]*$/],
      'background-color': [/^[^;{}()]*$/],
      'text-align': [/^(left|right|center|justify)$/],
      'font-size': [/^[\d.]+(px|em|rem|%|pt)$/],
      'font-weight': [/^(normal|bold|bolder|lighter|\d{3})$/],
      'font-style': [/^(normal|italic|oblique)$/],
      'font-family': [/^[\w\s,'"-]+$/],
      'text-decoration': [/^[\w\s-]+$/],
      'line-height': [/^[\d.]+(px|em|rem|%)?$/],
      margin: [/^[\d.\s]+(px|em|rem|%)?( [\d.\s]+(px|em|rem|%)?){0,3}$/],
      padding: [/^[\d.\s]+(px|em|rem|%)?( [\d.\s]+(px|em|rem|%)?){0,3}$/],
      width: [/^[\d.]+(px|em|rem|%)$/],
      height: [/^[\d.]+(px|em|rem|%)$/],
      'vertical-align': [/^[\w-]+$/],
    },
  },
  // Force external links to open in a new tab without leaking the opener.
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' }, true),
  },
};

// Sanitize a stored message body for raw rendering. Returns '' for empty input.
function sanitizeMessageHtml(html) {
  if (!html) return '';
  return sanitizeHtml(String(html), OPTIONS);
}

module.exports = { sanitizeMessageHtml };
