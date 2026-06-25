# World in Wonder — Current State

_Last updated: 2026-06-24. Branch `main` @ `54887f5`, in sync with `origin/main`. Per-child dates **deployed** (Amplify job 103) and **migrated** on prod._

Registration and admin web app for a kids' nature-program business
(worldinwonder.com). Public site for browsing programs and registering; a
session-protected `/admin` for managing programs, enrollments, rosters, and
email.

> Repo is named `growingwonder` (the former brand); the product is **World in
> Wonder**. Same codebase.

---

## Tech stack

- **Node.js / Express 4**, EJS server-rendered views.
- **DynamoDB** for all data (`@aws-sdk/lib-dynamodb`).
- **S3** (`wiw-media-assets`, us-west-1) for media + email attachments.
- **SES** for outbound email; **IMAP/SMTP** (cPanel) for the inbox.
- Runs on **AWS Amplify compute** (SSR Lambda, nodejs22.x) via
  `@codegenie/serverless-express`. `server.js` is the entrypoint; `app.js`
  builds the Express app.
- No build step / framework beyond EJS. No test suite yet.

---

## Deployment

- **Amplify app:** `growingwonder`, appId `d1bwwhwxg3laja`, region **us-west-1**,
  branch **main** (auto-builds on push).
- **Build:** `amplify.yml` copies source into `.amplify-hosting/compute/default`,
  writes a `.env` from Amplify app-level env vars (`echo "KEY=$KEY"`), and runs
  `npm ci --omit=dev`. **Any new env var must be added both to the Amplify
  console/app AND to `amplify.yml`'s echo list.** Env changes only reach the
  Lambda after a build (`aws amplify start-job ... --job-type RELEASE`).
- **Domain/DNS:** registrar + DNS stay at **Namecheap**. An A record there points
  web traffic to Amplify/CloudFront; `worldinwonder.com` 302-redirects to
  `www.worldinwonder.com`. MX points to the cPanel mail servers. Nothing in this
  app modifies DNS, MX, or the mailboxes.
- **AWS account:** 213117946893 (IAM user `bryan` for CLI ops).

---

## Rollback

How to undo a bad deploy or migration. Tooling lives in the repo:
`db/backup_tables.js` (logical JSON snapshot of a table) and
`db/restore_tables.js` (re-put items; `DRY_RUN` supported). **Always snapshot
`wiw-registrations` + `wiw-dates` before any data migration.**

**Code (Amplify).** Fastest: console → app `growingwonder` → branch `main` →
redeploy the last-good job. Or reset and force-push (triggers a build):
`git reset --hard <good-commit-or-tag> && git push --force origin main`. Tag the
pre-change commit before deploying so the rollback target is unambiguous.

**DB (DynamoDB).** Three options, fastest first:
1. **In-place re-put** from a logical snapshot:
   `BACKUP_DIR=<dir> DRY_RUN=1 node db/restore_tables.js`, then again without
   `DRY_RUN`. Caveat: rows created *after* the snapshot are left in place (not
   deleted) — re-run the relevant migration afterward to reconcile, or accept
   minor drift.
2. **On-demand backup** → restore to a new table, then swap.
3. **PITR** (point-in-time) where enabled — currently **on for `wiw-registrations`,
   off for `wiw-dates`**.

**Per-child-dates change (2026-06-24), if it must be undone:**
- Code → redeploy Amplify **job 102** (commit `1eadd60`, tag `prod-pre-perchild`).
- DB → pre-migration logical snapshot at `~/wiw-backups/2026-06-24-pre-migration/`
  (bryan's machine); server-side on-demand backups
  `wiw-registrations-preperchild-20260624-202124` and
  `wiw-dates-preperchild-20260624-202124`; full runbook in
  `~/wiw-backups/2026-06-24-pre-perchild/ROLLBACK.md`.
- The migration only added `child.dates` to registrations and rewrote
  `wiw-dates.enrolled`, so restoring those two tables fully reverses it.

---

## Repo layout

```
app.js / server.js        Express app + Lambda/local entrypoint
amplify.yml               Amplify build spec (env baking lives here)
deploy-manifest.json      Amplify compute routing/runtime
routes/
  public.js               public site + registration + contact inquiry
  admin.js                all of /admin (auth, programs, enrollments, messages…)
  api.js                  /api/dates/:programId; /api/cron/sync-inbox (token-gated)
lib/
  auth.js, session.js     admin auth + cookie session
  security.js             helmet CSP, rate limits, session CSRF
  env.js                  .env loader (no dotenv dep)
  site.js                 site name/phone/email constants
  storage.js              S3 upload (presigned + server-side putBuffer)
  mailer.js               SES outbound (raw MIME; sets Message-ID)
  email-html.js           normalizes editor HTML for email
  mail-config.js          per-mailbox creds (MAIL_*), shared by IMAP + SMTP
  imap-sync.js            inbound IMAP mirror -> wiw-email-queue
  smtp.js                 reply via the mailbox (nodemailer)
db/
  dynamo.js               all DynamoDB access
  seed.js, repair_*.js    seed + one-off repair scripts
  migrate_per_child_dates.js  backfill child.dates + recompute enrolled as heads
  backup_tables.js, restore_tables.js  logical DynamoDB snapshot + restore (rollback)
views/                    EJS (public) + views/admin/* (admin)
scripts/test-imap.js      standalone mailbox connectivity check (no DB writes)
```

---

## Data model (DynamoDB, all `wiw-*`)

- **wiw-programs** — programs; custom form config + custom questions per program.
- **wiw-dates** — available dates per program; `enrolled` atomic counter vs
  `maxCapacity`. `enrolled` counts **children attending per day (heads)**, not
  registrations/families.
- **wiw-registrations** — one item per registration. Each child carries its own
  `dates` (`children: [{name, dob, healthcareProvider, allergies, dates}]`);
  `selectedDates` is the derived **union** of all children's dates, kept in sync
  on every write (family-level readers still use it). `customResponses:
  [{label, value}]` holds answers to a program's custom questions.
- **wiw-email-queue** — outbound **and** inbound messages (see below).
- **wiw-inquiries** — website contact-form submissions (separate from email).
- **wiw-pages** — editable CMS pages (home, about).

---

## Features

**Public** (`routes/public.js`)
- Program pages, multi-select calendar registration (week toggle, capacity-aware),
  multi-child support, custom per-program questions, contact form (→ inquiries).
  Date selection on the public form is **family-level** (every child gets the
  family's selected dates); per-child differences are an admin-only edit.
- On registration: enrolled counters bump atomically and a confirmation email is
  **queued as a draft** in `wiw-email-queue`.

**Admin** (`routes/admin.js`, session-protected)
- Dashboard, Programs (rich editor), Site Pages.
- Enrollments: registrations / payments / summary / printable rosters / CSV import.
  Per-child **date editor** (`/admin/enrollments/:id/edit-dates`) adds/removes/moves
  days per child (capacity is heads; admin edits may exceed it with a warning).
  Summary and rosters auto-default to the program with the most active
  registrations instead of rendering a blank selector.
- Messages: **Inbox**, **Bulk Send**, **Inquiries** (details below).

---

## Messaging / Inbox subsystem

The Messages → **Inbox** tab (route still `?tab=confirmations`) is a general
inbox that mirrors both Namecheap mailboxes and threads them with outbound mail.

**Storage** — `wiw-email-queue` holds both directions, distinguished by
`direction` (`'in'` | `'out'`; missing = `'out'` for legacy rows):
- Outbound: `status` draft|sent|failed, `toAddr`, `subject`, `body`, `messageId`,
  `registrationId`, attachments.
- Inbound: `mailbox` (registration|info), `fromAddr/fromName`, `bodyText`,
  `messageId`, `inReplyTo`, `references`, `imapUid`/`imapUidValidity`, `read`,
  attachments (→ S3). Row id is **deterministic** = `in_<sha1(mailbox|messageId)>`
  so re-pulls overwrite instead of duplicating.

**Outbound (SES)** — `lib/mailer.js` sends via SES (raw MIME, sets a stable
`Message-ID`). Confirmation drafts are edited/sent from the admin; bulk send and
inquiry replies also go through SES.

**Inbound (IMAP mirror)** — `lib/imap-sync.js` reads both cPanel mailboxes over
IMAP and stores messages as `direction:'in'`. Read-only against IMAP (never
deletes/moves mail; the mailbox stays the source of truth). Sync is **on-demand**
(Lambda has no long-lived process): `POST /admin/messages/refresh`, auto-fired on
Inbox load plus a Refresh button. Cursor is stateless — derived from the max IMAP
uid per uidvalidity already stored. Capped at 100 messages/mailbox/run,
oldest-first, so a backlog catches up gap-free over repeated refreshes. Optional
`GET /api/cron/sync-inbox?key=MAIL_CRON_KEY` exists for a scheduled trigger (not
configured).

**Threading** — threads key on `registrationId` or the counterparty address.
Inbound resolves to a registration via `In-Reply-To`/`References` matching an
outbound `Message-ID`, else the most-recent outbound to that sender; otherwise it
becomes an address-keyed thread (`/admin/messages/thread/addr/:addr`). The
thread view shows messages **newest-first**, inbound rendered as **escaped text**
(no stored XSS), and offers a reply.

**Reply (SMTP)** — `lib/smtp.js` sends replies through the mailbox (nodemailer)
so they land in the mailbox Sent folder and thread for the recipient; the mirror
picks the copy back up. Falls back to SES if SMTP isn't configured.

**Thread view also surfaces the registrant's custom-question answers** in a
prominent "Respondent's answers" block (previously buried in a collapsed
accordion).

---

## Mail configuration

The mailboxes are **Namecheap cPanel email accounts** (not Private Email).

| Setting        | Value                                            |
|----------------|--------------------------------------------------|
| `MAIL_HOST`    | `server370.web-hosting.com` (IMAP 993 / SMTP 465)|
| Reg mailbox    | `MAIL_REG_USER` / `MAIL_REG_PASS` (registration@)|
| Info mailbox   | `MAIL_INFO_USER` / `MAIL_INFO_PASS` (info@)       |
| SES senders    | `SES_FROM_EMAIL_REG`, `SES_FROM_EMAIL_INFO`       |
| Optional cron  | `MAIL_CRON_KEY` (unset)                           |

**Host gotcha:** cPanel's "Mail Client" screen lists the server as
`worldinwonder.com`, which does **not** work here — that name resolves to the
Amplify/CloudFront website, not the mail server. The real host
`server370.web-hosting.com` was found via the SPF-authorized IP `69.57.162.144`
→ reverse DNS; its TLS cert is `*.web-hosting.com`, so connecting by that name
validates. If Namecheap migrates the hosting account to another server, update
`MAIL_HOST`.

Other env: `SESSION_SECRET`, `ADMIN_USER`/`ADMIN_PASS`, `WIW_ACCESS_KEY_ID`/
`WIW_SECRET_ACCESS_KEY`, `WIW_S3_BUCKET`, `WIW_AWS_REGION`. (Legacy `SMTP_*`
placeholders in a local `.env` are unused.)

---

## Recent changes

- `fb5c585` — **per-child date editing + head-count capacity** (this session):
  dates moved onto each child; `enrolled` now counts heads/day not families; new
  admin per-child date editor; summary/rosters default to the most-active program.
  Deployed (Amplify job 103) and migrated on prod via
  `db/migrate_per_child_dates.js` (27 regs backfilled, 14 counters recomputed; no
  over-capacity). Pre-migration snapshot + rollback runbook in
  `~/wiw-backups/2026-06-24-pre-migration/`.
- `54887f5` / `e3070ff` — ops: DynamoDB logical backup + restore scripts; added
  this doc to the repo.
- `4a96323` — inbox: newest-first sort, dropped the Mailbox column.
- `1eadd60` — idempotent inbound writes (deterministic id) to stop duplicates;
  thread view newest-first.
- `61ef77a` — surfaced registrant answers in the thread view.
- `09fd7c5` — built the inbound IMAP mirror + SMTP reply + Inbox UI.
- Earlier live config: `MAIL_HOST` = `server370.web-hosting.com`, both mailbox
  passwords set; one-off fix removed 65 duplicate inbound rows.

---

## Known issues / loose ends

- **Inbound egress on Lambda is unverified end-to-end.** IMAP/SMTP auth was
  proven from a local machine; the deployed function's outbound reach to 993/465
  is assumed (Amplify compute has internet egress by default). If a Refresh
  errors in prod, check the function logs for connection failures.
- **Backlog:** mailboxes hold ~143 (reg) / ~119 (info) messages; the first syncs
  pulled within a 90-day window, 100/run. Repeated Refreshes walk the rest.
- **Justine Delfino's** confirmation is an unsent **draft** (never sent).
- **No automated tests.** Verification is manual (`scripts/test-imap.js` for
  mailbox connectivity; render/load checks during development).
- `amplify.yml` echoes `MAIL_*`, so those env vars must also exist on the Amplify
  app or a build will bake empty values.

---

## Local dev / verification

```bash
npm start              # node server.js (PORT env or random)
npm run dev            # node --watch server.js
node scripts/test-imap.js   # check mailbox IMAP connectivity (needs MAIL_* set; no DB writes)
```

AWS access uses `WIW_*` creds if set, else the default credential chain. Region
defaults to us-west-1.
