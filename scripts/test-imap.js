#!/usr/bin/env node
// Standalone IMAP connectivity check for the configured mailboxes.
//
// Connects to each mailbox set via MAIL_* env vars, opens INBOX, and prints the
// message count and a few recent subjects. Does NOT touch DynamoDB or S3, so it
// isolates the "can we reach and authenticate to the mailbox?" question from the
// rest of the app (useful for verifying credentials and Lambda/VPC egress).
//
// Usage (from the project root, with MAIL_* exported or in .env):
//   node scripts/test-imap.js

const { ImapFlow } = require('imapflow');
require('../lib/env').loadEnv();
const mailConfig = require('../lib/mail-config');

(async () => {
  const accounts = mailConfig.configuredAccounts();
  if (accounts.length === 0) {
    console.error('No mailboxes configured. Set MAIL_REG_USER/MAIL_REG_PASS and/or MAIL_INFO_USER/MAIL_INFO_PASS.');
    process.exit(1);
  }
  console.log(`Host: ${mailConfig.HOST}:${mailConfig.IMAP_PORT}  (TLS)`);
  for (const account of accounts) {
    console.log(`\n=== ${account.key} (${account.user}) ===`);
    const client = new ImapFlow({ ...mailConfig.imapConnectionFor(account), socketTimeout: 15000 });
    try {
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');
      try {
        console.log(`  Connected. INBOX messages: ${client.mailbox.exists}, uidValidity: ${client.mailbox.uidValidity}`);
        const total = client.mailbox.exists;
        if (total > 0) {
          const from = Math.max(1, total - 4);
          console.log('  Recent subjects:');
          for await (const msg of client.fetch(`${from}:*`, { envelope: true })) {
            console.log(`    [${msg.uid}] ${msg.envelope && msg.envelope.subject || '(no subject)'}`);
          }
        }
      } finally {
        lock.release();
      }
      console.log('  OK');
    } catch (e) {
      console.error(`  FAILED: ${e.message}`);
    } finally {
      await client.logout().catch(() => {});
    }
  }
})();
