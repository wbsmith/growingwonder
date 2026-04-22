const { SESClient, SendRawEmailCommand } = require('@aws-sdk/client-ses');

const region = process.env.WIW_AWS_REGION || process.env.AWS_REGION || 'us-west-1';
const clientConfig = { region };
if (process.env.WIW_ACCESS_KEY_ID) {
  clientConfig.credentials = {
    accessKeyId: process.env.WIW_ACCESS_KEY_ID,
    secretAccessKey: process.env.WIW_SECRET_ACCESS_KEY,
  };
}
const ses = new SESClient(clientConfig);

const FROM = {
  registration: () => process.env.SES_FROM_EMAIL_REG,
  info: () => process.env.SES_FROM_EMAIL_INFO,
};

function isConfigured() {
  return !!(FROM.registration() || FROM.info());
}

function getFrom(purpose) {
  const addr = purpose === 'info' ? FROM.info() : FROM.registration();
  if (!addr) throw new Error(`SES not configured for "${purpose}".`);
  const site = require('./site');
  return `${site.name} <${addr}>`;
}

// opts: { from, to, subject, text, html, attachments: [{filename, content, contentType}], bcc: [] }
function buildMimeMessage(opts) {
  const boundary = '----=_Part_' + Date.now().toString(36);
  const altBoundary = '----=_Alt_' + Date.now().toString(36);
  const lines = [];

  lines.push('From: ' + opts.from);
  lines.push('To: ' + (Array.isArray(opts.to) ? opts.to.join(', ') : opts.to));
  if (opts.bcc && opts.bcc.length > 0) lines.push('Bcc: ' + opts.bcc.join(', '));
  lines.push('Subject: =?UTF-8?B?' + Buffer.from(opts.subject).toString('base64') + '?=');
  lines.push('MIME-Version: 1.0');

  const hasAttachments = opts.attachments && opts.attachments.length > 0;
  const hasHtml = !!opts.html;
  const hasText = !!opts.text;

  if (!hasAttachments && !hasHtml) {
    // Plain text only
    lines.push('Content-Type: text/plain; charset=UTF-8');
    lines.push('Content-Transfer-Encoding: 7bit');
    lines.push('');
    lines.push(opts.text || '');
  } else if (!hasAttachments && hasHtml) {
    // HTML with text fallback, no attachments
    lines.push('Content-Type: multipart/alternative; boundary="' + altBoundary + '"');
    lines.push('');
    if (hasText) {
      lines.push('--' + altBoundary);
      lines.push('Content-Type: text/plain; charset=UTF-8');
      lines.push('');
      lines.push(opts.text);
      lines.push('');
    }
    lines.push('--' + altBoundary);
    lines.push('Content-Type: text/html; charset=UTF-8');
    lines.push('');
    lines.push(opts.html);
    lines.push('');
    lines.push('--' + altBoundary + '--');
  } else {
    // Mixed: body + attachments
    lines.push('Content-Type: multipart/mixed; boundary="' + boundary + '"');
    lines.push('');

    if (hasHtml) {
      lines.push('--' + boundary);
      lines.push('Content-Type: multipart/alternative; boundary="' + altBoundary + '"');
      lines.push('');
      if (hasText) {
        lines.push('--' + altBoundary);
        lines.push('Content-Type: text/plain; charset=UTF-8');
        lines.push('');
        lines.push(opts.text);
        lines.push('');
      }
      lines.push('--' + altBoundary);
      lines.push('Content-Type: text/html; charset=UTF-8');
      lines.push('');
      lines.push(opts.html);
      lines.push('');
      lines.push('--' + altBoundary + '--');
    } else {
      lines.push('--' + boundary);
      lines.push('Content-Type: text/plain; charset=UTF-8');
      lines.push('');
      lines.push(opts.text || '');
    }

    for (const att of opts.attachments) {
      lines.push('');
      lines.push('--' + boundary);
      lines.push('Content-Type: ' + (att.contentType || 'application/octet-stream') + '; name="' + att.filename + '"');
      lines.push('Content-Disposition: attachment; filename="' + att.filename + '"');
      lines.push('Content-Transfer-Encoding: base64');
      lines.push('');
      const buf = Buffer.isBuffer(att.content) ? att.content : Buffer.from(att.content);
      const b64 = buf.toString('base64');
      for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
    }
    lines.push('');
    lines.push('--' + boundary + '--');
  }

  return lines.join('\r\n');
}

async function sendRaw(opts) {
  const raw = buildMimeMessage(opts);
  await ses.send(new SendRawEmailCommand({
    RawMessage: { Data: Buffer.from(raw) },
  }));
}

// Simple send: text or html body, optional attachments
// body can be plain text. If format='html', body is treated as HTML.
async function send(to, subject, body, purpose = 'registration', attachments = [], format = 'text') {
  const from = getFrom(purpose);
  const opts = { from, to, subject, attachments };
  if (format === 'html') {
    opts.html = body;
    // Strip HTML for plain text fallback
    opts.text = body.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
  } else {
    opts.text = body;
  }
  await sendRaw(opts);
}

async function sendBulk(bccAddresses, subject, body, purpose = 'info', attachments = [], format = 'text') {
  const from = getFrom(purpose);
  const batches = [];
  for (let i = 0; i < bccAddresses.length; i += 50) {
    batches.push(bccAddresses.slice(i, i + 50));
  }
  for (const batch of batches) {
    const opts = { from, to: from, bcc: batch, subject, attachments };
    if (format === 'html') {
      opts.html = body;
      opts.text = body.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
    } else {
      opts.text = body;
    }
    await sendRaw(opts);
  }
  return bccAddresses.length;
}

module.exports = { isConfigured, send, sendBulk };
