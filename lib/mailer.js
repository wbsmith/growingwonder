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
  const from = purpose === 'info' ? FROM.info() : FROM.registration();
  if (!from) throw new Error(`SES not configured for "${purpose}".`);
  return from;
}

// Build a raw MIME message with optional attachments
function buildMimeMessage(from, to, subject, textBody, attachments = [], bcc = []) {
  const boundary = '----=_Part_' + Date.now().toString(36);
  const lines = [];
  lines.push('From: ' + from);
  lines.push('To: ' + (Array.isArray(to) ? to.join(', ') : to));
  if (bcc.length > 0) lines.push('Bcc: ' + bcc.join(', '));
  lines.push('Subject: =?UTF-8?B?' + Buffer.from(subject).toString('base64') + '?=');
  lines.push('MIME-Version: 1.0');

  if (attachments.length === 0) {
    lines.push('Content-Type: text/plain; charset=UTF-8');
    lines.push('Content-Transfer-Encoding: 7bit');
    lines.push('');
    lines.push(textBody);
  } else {
    lines.push('Content-Type: multipart/mixed; boundary="' + boundary + '"');
    lines.push('');
    lines.push('--' + boundary);
    lines.push('Content-Type: text/plain; charset=UTF-8');
    lines.push('Content-Transfer-Encoding: 7bit');
    lines.push('');
    lines.push(textBody);
    for (const att of attachments) {
      lines.push('');
      lines.push('--' + boundary);
      lines.push('Content-Type: ' + (att.contentType || 'application/octet-stream') + '; name="' + att.filename + '"');
      lines.push('Content-Disposition: attachment; filename="' + att.filename + '"');
      lines.push('Content-Transfer-Encoding: base64');
      lines.push('');
      const buf = Buffer.isBuffer(att.content) ? att.content : Buffer.from(att.content);
      // Split base64 into 76-char lines
      const b64 = buf.toString('base64');
      for (let i = 0; i < b64.length; i += 76) {
        lines.push(b64.slice(i, i + 76));
      }
    }
    lines.push('');
    lines.push('--' + boundary + '--');
  }
  return lines.join('\r\n');
}

async function send(to, subject, textBody, purpose = 'registration', attachments = []) {
  const from = getFrom(purpose);
  const raw = buildMimeMessage(from, to, subject, textBody, attachments);
  await ses.send(new SendRawEmailCommand({
    RawMessage: { Data: Buffer.from(raw) },
  }));
}

async function sendBulk(bccAddresses, subject, textBody, purpose = 'info', attachments = []) {
  const from = getFrom(purpose);
  const batches = [];
  for (let i = 0; i < bccAddresses.length; i += 50) {
    batches.push(bccAddresses.slice(i, i + 50));
  }
  for (const batch of batches) {
    const raw = buildMimeMessage(from, from, subject, textBody, attachments, batch);
    await ses.send(new SendRawEmailCommand({
      RawMessage: { Data: Buffer.from(raw) },
    }));
  }
  return bccAddresses.length;
}

module.exports = { isConfigured, send, sendBulk };
