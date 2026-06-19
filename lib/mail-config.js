// Mailbox configuration for inbound (IMAP) and reply (SMTP) against the two
// Namecheap Private Email accounts that back the site:
//
//   registration@worldinwonder.com   — registration confirmations & replies
//   info@worldinwonder.com           — general inbound
//
// One credential set per mailbox is reused for IMAP (read) and SMTP (send),
// since both authenticate as the same mailbox login. Nothing here changes MX
// or DNS — we simply read and send through the existing Namecheap mailboxes.
//
// Env vars (set in the Amplify console; see amplify.yml):
//   MAIL_HOST       default mail.privateemail.com
//   MAIL_IMAP_PORT  default 993 (implicit TLS)
//   MAIL_SMTP_PORT  default 465 (implicit TLS)
//   MAIL_REG_USER / MAIL_REG_PASS    registration mailbox
//   MAIL_INFO_USER / MAIL_INFO_PASS  info mailbox

const HOST = process.env.MAIL_HOST || 'mail.privateemail.com';
const IMAP_PORT = parseInt(process.env.MAIL_IMAP_PORT, 10) || 993;
const SMTP_PORT = parseInt(process.env.MAIL_SMTP_PORT, 10) || 465;

// Each account: a stable `key` (also the label/badge in the inbox), the human
// display name used on outbound, and credentials pulled from env.
const ACCOUNTS = [
  {
    key: 'registration',
    label: 'Registration',
    user: () => process.env.MAIL_REG_USER,
    pass: () => process.env.MAIL_REG_PASS,
  },
  {
    key: 'info',
    label: 'Info',
    user: () => process.env.MAIL_INFO_USER,
    pass: () => process.env.MAIL_INFO_PASS,
  },
];

// Returns the configured accounts (those with both user + pass present).
function configuredAccounts() {
  return ACCOUNTS
    .map(a => ({ key: a.key, label: a.label, user: a.user(), pass: a.pass() }))
    .filter(a => a.user && a.pass);
}

function getAccount(key) {
  return configuredAccounts().find(a => a.key === key) || null;
}

// Map an incoming mailbox login (e.g. the address mail arrived to) back to an
// account key, so inbound stored under the right label.
function accountKeyForAddress(addr) {
  if (!addr) return null;
  const lower = addr.toLowerCase();
  const hit = configuredAccounts().find(a => a.user.toLowerCase() === lower);
  return hit ? hit.key : null;
}

function imapConnectionFor(account) {
  return {
    host: HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: account.user, pass: account.pass },
    logger: false,
  };
}

function smtpTransportFor(account) {
  return {
    host: HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: account.user, pass: account.pass },
  };
}

// True if at least one mailbox is configured for inbound/reply.
function isConfigured() {
  return configuredAccounts().length > 0;
}

module.exports = {
  HOST,
  IMAP_PORT,
  SMTP_PORT,
  configuredAccounts,
  getAccount,
  accountKeyForAddress,
  imapConnectionFor,
  smtpTransportFor,
  isConfigured,
};
