const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');

const region = process.env.WIW_AWS_REGION || process.env.AWS_REGION || 'us-west-1';
const clientConfig = { region };
if (process.env.WIW_ACCESS_KEY_ID) {
  clientConfig.credentials = {
    accessKeyId: process.env.WIW_ACCESS_KEY_ID,
    secretAccessKey: process.env.WIW_SECRET_ACCESS_KEY,
  };
}
const client = new SESClient(clientConfig);

const FROM = {
  registration: () => process.env.SES_FROM_EMAIL_REG,
  info: () => process.env.SES_FROM_EMAIL_INFO,
};

function isConfigured() {
  return !!(FROM.registration() || FROM.info());
}

async function send(to, subject, textBody, purpose = 'registration') {
  const from = purpose === 'info' ? FROM.info() : FROM.registration();
  if (!from) {
    throw new Error(`SES not configured for "${purpose}". Set SES_FROM_EMAIL_REG / SES_FROM_EMAIL_INFO env vars.`);
  }
  const cmd = new SendEmailCommand({
    Source: from,
    Destination: { ToAddresses: [to] },
    Message: {
      Subject: { Data: subject },
      Body: { Text: { Data: textBody } },
    },
  });
  return client.send(cmd);
}

async function sendBulk(bccAddresses, subject, textBody, purpose = 'info') {
  const from = purpose === 'info' ? FROM.info() : FROM.registration();
  if (!from) {
    throw new Error(`SES not configured for "${purpose}".`);
  }
  // SES allows max 50 recipients per call. Batch if needed.
  const batches = [];
  for (let i = 0; i < bccAddresses.length; i += 50) {
    batches.push(bccAddresses.slice(i, i + 50));
  }
  for (const batch of batches) {
    const cmd = new SendEmailCommand({
      Source: from,
      Destination: {
        ToAddresses: [from],
        BccAddresses: batch,
      },
      Message: {
        Subject: { Data: subject },
        Body: { Text: { Data: textBody } },
      },
    });
    await client.send(cmd);
  }
  return bccAddresses.length;
}

module.exports = { isConfigured, send, sendBulk };
