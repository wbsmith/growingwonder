# World in Wonder — Current State

_Last updated: 2026-08-29. Branch `main`. Pushed/deployed: registration fix (106, `4b1107d`), admin Registrations fix (107, `c888d4c`), inbox sync fix (108, `1377404`), DynamoDB pagination + first tests (109, `98f02a5`), mobile scroll-lock CSS (`8097a2d`), mobile capacity save (`60f6a61`). Latest work (**local only, not pushed/deployed**): **Inbox "real email client" upgrade** — no-reload live feed poll, full-text search, message-level archive/triage, and a read-only delivery-issues panel. This is the inbox-client half of a larger email overhaul; the SES outbound engine / compose / bounce webhook are a separate workstream (not built here). Per-child dates deployed (job 103) and migrated on prod._

> **History — 2026-07-15:** (1) public registration broken since `fb5c585`
> (arithmetic in a DynamoDB `ConditionExpression`) → job 106; (2) admin per-row
> **Delete** was a `<form>` nested in the merge `<form>`; **Merge** never
> reconciled head-counters → job 107; (3) inbox sync **resurrected** soft-deleted
> mail (cursor/dedup excluded deleted rows) and one bad message **stalled** newer
> mail → job 108.
> **2026-07-29:** the inbox was silently **dropping ~1/3 of messages** — `getAllEmails`
> (and ~12 other reads) issued a single un-paginated DynamoDB Scan/Query, and
> `wiw-email-queue` had crossed the 1 MB page limit (1.48 MB / 335 rows → only 228
> on page 1). Root cause of "Peterman not in the inbox." Fixed by paginating every
> unbounded read; added `npm test` with a guard that fails on any bare scan/query.

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
- No build step / framework beyond EJS. Tests run on Node's built-in runner:
  `npm test` (`node --test test/*.test.js`); see `test/pagination.test.js`.

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
  dates.js                today() in America/Los_Angeles (PST/PDT) for past-date cutoffs
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
  registrations/families. When a row lacks `maxCapacity`, both the capacity
  pre-check and the atomic guard fall back to `db.DEFAULT_DATE_CAPACITY` (12) —
  one shared constant so they can't disagree.
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
  family's selected dates); per-child differences are an admin-only edit. The
  calendar only offers **upcoming** dates — `/api/dates/:programId` filters out
  any date before today (Pacific), and `POST /register` re-checks so a stale page
  can't book a passed date.
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
uid per uidvalidity already stored, **counting soft-deleted rows too** so the
cursor is monotonic and deleting the newest message can't rewind it and re-pull
deleted mail (`getInboundState`). Capped at 100 messages/mailbox/run, oldest-first,
so a backlog catches up gap-free over repeated refreshes; the Inbox reloads once
per batch while draining (auto-refresh at `messages.ejs`). A message that can't be
parsed/stored is skipped and gets a `deletedAt` `status:'sync_failed'` tombstone so
its uid advances the cursor and one bad message can't stall newer mail. Optional
`GET /api/cron/sync-inbox?key=MAIL_CRON_KEY` exists for a scheduled trigger (not
configured).

> **Limitation:** the first sync per mailbox only pulls `MAIL_FIRST_RUN_DAYS`
> (default 90) of history; once the cursor is set it only moves forward, so mail
> older than that window is never pulled. Not backfilled by decision. To recover
> it later would need a one-time full-history walk (reset cursor / ignore window).

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

**Live inbox (no-reload) + search + triage (2026-08-29, local only).** The Inbox
is now a live client instead of a reload loop:
- **`buildThreads(emails, {filter, q, archived})`** (`lib/threads.js`) is the
  single grouping/filter/search function, shared by the server render of
  `GET /messages` and the JSON feed. Extracted verbatim from the old inline logic
  (thread shape unchanged) and given `q` (case-insensitive Node-side substring
  search over subject/body/bodyText/fromAddr/fromName/toAddr/parentName/childName)
  and archive-visibility handling.
- **Feed poll.** `GET /admin/messages/feed?filter&q` returns
  `{serverTime, unreadInbound, newInquiries, failuresCount, threads}`. The inbox
  polls it every 15s (paused when `document.hidden`, and immediately on tab
  re-focus), upserting rows by `data-thread-key` (skipping unchanged rows via a
  `data-sig`), and updates the sidebar unread pill — no full-page reload. Short
  poll, **not SSE** (Amplify/Lambda has no durable connections). The Refresh
  button runs the IMAP `/refresh` then patches the DOM from the feed.
- **Shared row renderer.** `public/js/inbox-render.js` exports an isomorphic
  `renderThreadRow(t)` — the browser loads it as a global for live rows and
  `routes/admin.js` `require()`s the same file for the initial server render, so
  the two can't drift. No-JS deep-links still work (`GET /messages?q=&filter=` is
  honored server-side).
- **Short-lived scan cache.** `db.getAllEmails()` memoizes the full
  `wiw-email-queue` scan for ~8s (`EMAILS_CACHE_TTL_MS`, default 8000) so several
  tabs polling every 15s don't each re-scan the ~1.5 MB table. Every email write
  (`createInbound/Outbound`, `markEmailSent/Failed/Read`, `updateEmailDraft`,
  attach/detach, soft-delete, archive/unarchive, and the reg create/delete/merge
  paths) calls `invalidateEmailsCache()`, so a reply/sync/archive shows on the
  next read — not a correctness dependency, just a scan saver.
- **Archive / triage.** Message-level `archivedAt`/`archivedBy` mirror the
  `deletedAt` soft-delete but are independent of it (`db.archiveMessages`/
  `unarchiveMessages`; `POST /admin/messages/archive` + `/unarchive`, comma-joined
  ids like delete). A thread is "archived" only when **every** message is archived,
  so a new non-archived inbound message auto-resurfaces it. Default filters hide
  archived threads **except** those with an unsent draft. New filter chips:
  `archived` (archived only) and `general` (threads with no `registrationId` — the
  unlinked info@ mail). Archive buttons on inbox rows and in the thread view.
- **Delivery-issues panel (read-only, optional).** `tab=failures` lists rows in
  `failed`/`bounced`/`complained`/`suppressed` via `db.getEmailsByStatuses` (the
  `status-index` GSI, no scan); a sidebar "Delivery Issues" pill appears only when
  the count is >0. **Empty until the outbound-delivery workstream** records those
  statuses.

**XSS (fixed).** Outbound bodies in `thread_view.ejs` are rendered raw (to show
rich-text HTML) but now pass through `lib/sanitize.js` `sanitizeMessageHtml()`
(the `cleanHtml` local) — built on the `sanitize-html` dependency — which strips
`<script>`, `on*` handlers, `javascript:` URLs, `<iframe>`, and dangerous inline
styles while keeping Quill formatting. Inbound is still escaped as text. Also
hardened the inbox search script injection (`messages.ejs` `?q=` was emitted into
a `<script>` via `JSON.stringify` without escaping `<`). Covered by
`test/sanitize.test.js`. Safe for inbound HTML rendering now too.

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

- **(2026-08-29) Inbox live-updates + search + archive** (local only, not
  deployed): built the inbox-client half of the email overhaul — see the
  "Live inbox" block under *Messaging / Inbox subsystem*. New: `lib/threads.js`
  (`buildThreads`), `public/js/inbox-render.js` (isomorphic `renderThreadRow`),
  `GET /admin/messages/feed`, `POST /admin/messages/archive` + `/unarchive`,
  `tab=failures` panel, a ~8s TTL cache around `getAllEmails` with write-driven
  invalidation, and message-level `archivedAt`/`archivedBy`. New db fns:
  `archiveMessages`, `unarchiveMessages`, `getEmailsByStatuses`,
  `invalidateEmailsCache`. Tests: `test/threads.test.js` (grouping, `q` search,
  archive hide/show + draft exception + auto-resurface, `general` filter, the
  archive db fns, and the getAllEmails cache) — `npm test` green (14 tests).
  Out of scope by design (separate workstream): SES send engine, compose/fan-out,
  the SNS bounce webhook, and populating the failures panel.
- **(2026-08-02) mobile capacity save didn't submit** (deployed, `60f6a61`): on the
  program Dates screen, the per-day capacity `<input type="number">` relied on the
  in-page `✓` submit button. On iOS the numeric keypad's done/checkmark key blurs
  the field *without* triggering implicit form submission, so tapping it silently
  discarded the edit — an admin thought they'd set a day to 7 but it stayed at 10,
  and 8 had already enrolled legitimately under 10 (lowering a cap never evicts
  existing enrollees). Fixed by also submitting on the input's `change` event
  (`onchange="this.form.submit()"`), so the keyboard checkmark now saves. No
  enrollment-limit bug: counters verified correct against registrations.
- **(2026-07-30) mobile admin scroll-lock** (deployed, `8097a2d`): on mobile the admin
  pages (worst: the email editor) scrolled to the top and stuck. Cause:
  `.admin-main { overflow-x: auto }` also forces `overflow-y: auto` (CSS spec),
  making it a vertical scroll container; stacked under the full-width nav on
  mobile it became a short trapped pane. Fixed with `overflow-x: visible` on
  `.admin-main` inside the ≤768px media query so the page scrolls naturally.
  Desktop (fixed-sidebar scrolling pane) unchanged. Known follow-up: wide tables
  (inbox/enrollments) may now scroll the page horizontally on mobile.
- **(2026-07-29) DynamoDB pagination — full fix + tests** (deployed, job 109 / `98f02a5`):
  - **Bug:** DynamoDB Scan/Query return ≤1 MB per page; `getAllEmails` and ~12
    other reads did a single un-paginated call. Once `wiw-email-queue` passed 1 MB
    (1.48 MB, 335 rows), the Inbox saw only page 1 (228 rows) — the rest (incl. a
    new registration's confirmation draft) silently vanished. That was the
    "Peterman not showing in the inbox" report.
  - **Fix:** added `scanAll` / `queryAll` / `paginatedCount(CommandClass, params)`
    helpers that follow `LastEvaluatedKey`, and routed every unbounded read through
    them (emails, registrations, inquiries, programs, dates; the unread/pending/new
    counts). `getRegistrationCountsByProgram` already paginated.
  - **Tests:** first suite — `npm test` (`node --test`). `test/pagination.test.js`
    proves multi-page aggregation for scan/query/count reads and includes a
    **static guard** that fails if any `client.send(new Scan/QueryCommand(...))`
    appears outside an `ExclusiveStartKey` loop.
- **(2026-07-15) inbox IMAP-sync fixes** (deployed, job 108 / `1377404`):
  - **Deleted mail no longer resurrects.** `getInboundState` derived the sync
    cursor and dedup set from a scan that *excluded* soft-deleted rows, so
    deleting the newest inbound message rewound the high-water mark and dropped
    its Message-ID from dedup — the next sync re-pulled and re-`Put` it (clearing
    `deletedAt`). Now the scan includes soft-deleted rows as sync tombstones:
    deletes stay deleted and the cursor is monotonic.
  - **One bad message no longer stalls the mailbox.** The fetch loop had no
    per-message guard, so a single unparseable/oversized message aborted the run
    and blocked every newer (higher-uid) message behind it. Each message is now
    wrapped; a failure logs and writes a `deletedAt` `status:'sync_failed'`
    tombstone so the cursor advances past it. `syncAllMailboxes` returns `skipped`.
  - Left as-is by decision: the 90-day first-run floor (no backfill) and the
    reload-on-new-mail loop (`messages.ejs`) — it terminates once the backlog
    drains, and the resurrection fix stops deletes from re-triggering it.
- **(2026-07-15) admin Registrations-tab fixes** (deployed, job 107 / `c888d4c`):
  - **Per-row Delete was broken.** Each row's Delete `<form>` was nested inside
    the page-wide merge `<form>` — invalid HTML, so browsers drop the inner form
    and the button submitted the *merge* form ("No registrations selected." /
    "Select at least 2… to merge."). Unwrapped the table from the merge form and
    bound the row checkboxes to it via `form="mergeForm"`; delete forms are now
    standalone. Added a missing-id guard to the delete route.
  - **Merge now reconciles head counters.** `mergeRegistrations` dedups children
    (by name+dob) but never adjusted `wiw-dates.enrolled`, so merging true
    duplicates left counters **inflated** (skewing the Summary head-count and the
    public capacity gate). It now releases the double-counted heads per date
    (guarded, non-negative). Covers Auto-Merge too (it delegates to merge).
    **Note:** this fixes *future* merges; counters already drifted from past
    merges need a one-time recompute (see `db/migrate_per_child_dates.js`, which
    recomputes every `enrolled` as total heads).
- **(2026-07-15) registration-form fixes** (deployed, Amplify job 106 / `4b1107d`):
  - **Fixed production-down bug.** `createRegistration` built a DynamoDB
    `ConditionExpression` with arithmetic (`enrolled + :n <= maxCapacity`), which
    DynamoDB rejects (arithmetic is update-expression-only). It raised
    `ValidationException`, not the `ConditionalCheckFailed` the route maps to a
    capacity message, so all registrations to dated programs failed with the
    generic error. Now precomputes each date's ceiling client-side and compares
    `enrolled <= :ceil`. Broken since `fb5c585` (2026-06-24).
  - **One capacity default.** Added `db.DEFAULT_DATE_CAPACITY` (12); the public
    pre-check and the atomic guard both use it (via a `typeof` check, so a real
    capacity of `0` means closed, not 12) instead of disagreeing.
  - **Hide past dates.** New `lib/dates.js` `today()` in `America/Los_Angeles`
    (PST/PDT auto). `/api/dates/:programId` filters out passed dates; `POST
    /register` rejects them defensively.
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
- **Tests are minimal.** `npm test` (Node's built-in runner) covers DynamoDB
  pagination (`test/pagination.test.js`), inbox thread-building / archive / cache
  (`test/threads.test.js`), and HTML sanitization (`test/sanitize.test.js`). No
  route-level / integration tests yet; the authenticated feed round-trip and IMAP
  paths are still verified manually (`scripts/test-imap.js` for mailbox connectivity).
- **npm audit: 7 pre-existing vulns** (6 high) in the mail stack's transitive deps
  (`brace-expansion`, `html-to-text`/`deepmerge-ts`, `ip-address`, `linkify-it` via
  `mailparser`/`imapflow`/`nodemailer`) — not from `sanitize-html`. `npm audit fix`
  would bump majors in that stack; deferred as a separate, tested cleanup.
- **Delivery-issues panel is empty** until the outbound-delivery workstream writes
  `bounced`/`complained`/`suppressed` rows.
- **Admin default-program `today` still uses UTC** (`routes/admin.js`, the
  most-active-program pick). Cosmetic only (which program is pre-selected); not
  switched to Pacific yet for scope. The public past-date cutoff uses `lib/dates`.
- **Deleting a registration also deletes its Inbox thread** — by design.
  `deleteRegistration` removes *every* `wiw-email-queue` row with that
  `registrationId` (inbound customer replies included, not just the outbound
  confirmation). Confirmed intended behavior (2026-07-15): purge-all on delete.
- **Historical merge counter drift** — none expected currently. The merge-counter
  fix (2026-07-15) corrects new merges only; per prod owner no duplicate merges
  have been run, so no `wiw-dates.enrolled` reconcile is needed. If merges were
  ever run before that fix, recompute via `db/migrate_per_child_dates.js`.
- **Inbox: mail older than 90 days is not mirrored** — the first-sync window
  (`MAIL_FIRST_RUN_DAYS`) is a permanent floor and isn't backfilled (by decision).
  Would need a one-time full-history walk to recover.
- **Inbox reloads while draining a backlog** — auto-sync on Inbox load reloads the
  page once per 100-message batch until caught up (`messages.ejs`). Terminates on
  its own; not converted to a single server-side drain (deferred).
- **No audit trail for capacity (or admin) changes.** `updateDateCapacity` does a
  bare `SET maxCapacity` — no who/when/old-value. Made the "set to 7 but see 8"
  report hard to reconstruct. A lightweight change log (esp. for capacity) is a
  good targeted add.
- **Lowering a day's capacity below its current enrollment is silent.** The route
  flashes plain success even when `enrolled > new cap`; no eviction happens (by
  design) and no warning is shown. Consider flagging over-capacity on save (as the
  per-child date editor already does).
- `amplify.yml` echoes `MAIL_*`, so those env vars must also exist on the Amplify
  app or a build will bake empty values.

---

## Local dev / verification

```bash
npm start              # node server.js (PORT env or random)
npm run dev            # node --watch server.js
npm test               # node --test test/*.test.js (pagination suite + static guards)
node scripts/test-imap.js   # check mailbox IMAP connectivity (needs MAIL_* set; no DB writes)
```

AWS access uses `WIW_*` creds if set, else the default credential chain. Region
defaults to us-west-1.
