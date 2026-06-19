// Sends replies through the Namecheap mailbox itself (SMTP), rather than via
// SES, so the reply lands in the mailbox's Sent folder and threads correctly in
// the recipient's client. The IMAP mirror then picks the reply back up, keeping
// the Namecheap mailbox the single source of truth for the conversation.
//
// Uses the same per-mailbox credentials as the IMAP reader (lib/mail-config).

const nodemailer = require('nodemailer');
const mailConfig = require('./mail-config');
const site = require('./site');
const { normalizeEmailHtml } = require('./email-html');

function isConfigured() {
  return mailConfig.isConfigured();
}

// opts: { accountKey, to, subject, html|text, inReplyTo, references[], attachments[] }
// Returns the sent Message-ID so the caller can store it for future threading.
async function sendReply(opts) {
  const account = mailConfig.getAccount(opts.accountKey) || mailConfig.configuredAccounts()[0];
  if (!account) throw new Error('No mailbox configured for replies.');

  const transporter = nodemailer.createTransport(mailConfig.smtpTransportFor(account));

  const message = {
    from: `${site.name} <${account.user}>`,
    to: opts.to,
    subject: opts.subject,
  };
  if (opts.html) {
    message.html = normalizeEmailHtml(opts.html);
    message.text = opts.html
      .replace(/<[^>]*>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
  } else {
    message.text = opts.text || '';
  }

  // RFC 5322 threading headers so the recipient's client groups the reply with
  // the original message.
  if (opts.inReplyTo) message.inReplyTo = opts.inReplyTo;
  if (opts.references && opts.references.length) message.references = opts.references;

  if (opts.attachments && opts.attachments.length) {
    message.attachments = opts.attachments.map(a => ({
      filename: a.filename,
      content: a.content,
      contentType: a.contentType,
    }));
  }

  const info = await transporter.sendMail(message);
  return { messageId: info.messageId, account: account.key, from: account.user };
}

module.exports = { isConfigured, sendReply };
