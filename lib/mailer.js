const { SESv2Client } = require('@aws-sdk/client-sesv2');
const nodemailer = require('nodemailer');
const aws = require('@aws-sdk/client-sesv2');

const region = process.env.WIW_AWS_REGION || process.env.AWS_REGION || 'us-west-1';
const clientConfig = { region };
if (process.env.WIW_ACCESS_KEY_ID) {
  clientConfig.credentials = {
    accessKeyId: process.env.WIW_ACCESS_KEY_ID,
    secretAccessKey: process.env.WIW_SECRET_ACCESS_KEY,
  };
}
const ses = new SESv2Client(clientConfig);
const transporter = nodemailer.createTransport({ SES: { ses, aws } });

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

// attachments: [{filename, content (Buffer), contentType}] or [{filename, path (S3 URL)}]
async function send(to, subject, textBody, purpose = 'registration', attachments = []) {
  const mailOpts = {
    from: getFrom(purpose),
    to,
    subject,
    text: textBody,
  };
  if (attachments.length > 0) {
    mailOpts.attachments = attachments;
  }
  return transporter.sendMail(mailOpts);
}

async function sendBulk(bccAddresses, subject, textBody, purpose = 'info', attachments = []) {
  const from = getFrom(purpose);
  const batches = [];
  for (let i = 0; i < bccAddresses.length; i += 50) {
    batches.push(bccAddresses.slice(i, i + 50));
  }
  for (const batch of batches) {
    const mailOpts = { from, to: from, bcc: batch, subject, text: textBody };
    if (attachments.length > 0) mailOpts.attachments = attachments;
    await transporter.sendMail(mailOpts);
  }
  return bccAddresses.length;
}

module.exports = { isConfigured, send, sendBulk };
