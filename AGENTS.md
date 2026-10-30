# AGENTS.md

Working notes for this repo: how to set it up, how the pieces fit, and the
reasoning behind behaviour that would otherwise look arbitrary. The
[README](README.md) is deliberately kept to "what is this and why would I use
it" — everything technical belongs here.

**This file describes the app as it is, not how it got here.** Write down the
current rule and, where the obvious alternative is wrong, one or two sentences
on why — enough that nobody reintroduces it. Leave out "it used to be…",
removed features, and the story of a change; that is what commit messages and
`git log` are for. When something changes, rewrite the paragraph rather than
appending to it. Reasoning that belongs to one component goes in a comment in
that component, not here.

## Stack and layout

React 19 + Vite, [Mantine](https://mantine.dev) for UI,
[Phosphor](https://phosphoricons.com) for icons,
[Supabase](https://supabase.com) for Postgres and auth, `react-router-dom` with
hash-based routing, deployed to GitHub Pages by
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml).

```
src/pages/       route components (Home, SignIn, PollList, CreatePoll, PollPage — which picks PollDetail or PublicPoll — Learn, Settings, InstallGuide, Intro, Donate, Contact)
src/components/  poll UI pieces: the ballots (BallotFrame, BallotCard, TimeBallotCard), the calendar
                 the painting screens share (PaintCalendar, ScheduleFields, PaintTimes, HoursFields),
                 results and ballots (Results, Ballots, YourBallot, ScheduleBallots, FullRanking, CoinFlip),
                 the collecting stage (CollectOptions, TimeList), the poll heading and its tags,
                 notifications (NotificationSwitches, PushSwitch, Banners), motion helpers (Reveal,
                 SmoothHeight, PollCards), the ways back (BackToHome, BackToList), the home page's
                 ballot loop (StarLoop), ErrorBoundary, Announcer, and the intro film under intro/
src/lib/         the supabase client and auth context, the one read that opens a poll (pollPage.ts),
                 poll id spelling (pollId.ts), live updates (useLiveStream.ts, readLedger.ts),
                 time-poll arithmetic (schedule.ts, timezones.ts), drafts, limits, push, motion,
                 the sample poll, and shared types — each file says what it is for at its top
public/          served as-is: icons, the web app manifest and its screenshots, the intro's
                 footage (intro/), the service worker
supabase/migrations/  the schema, as ordered SQL files
supabase/after-squash.sql  the statements a schema dump cannot carry
supabase/functions/   Edge Functions: send-push, the half of a push notification Postgres cannot do
scripts/         squash.sh (squashes the migrations); sample-poll.sh (records the sample poll);
                 intro/ (records the intro's app footage on the live site; record.mjs says how)
test/            tally tests run against a throwaway Postgres; build-db.sh builds it
e2e/             the browser suite; screenshots.capture.ts (the manifest's screenshots)
```

Scripts: `npm run dev`, `npm run build` (`tsc -b && vite build`),
`npm run lint` (oxlint), `npm run fmt` (oxfmt; `npm run fmt:check` reports
without writing), `npm run preview`, `npm test`, `npm run test:unit` and
`npm run test:e2e` (see [Tests](#tests)), `npm run screenshots` (see
[What the manifest says](#what-the-manifest-says)).

The formatter is configured in `.oxfmtrc.json` — no semicolons, single quotes,
a hundred columns — and skips Markdown, since this file and the README are
wrapped by hand.

**Line endings.** Everything is stored and checked out with LF, which
[`.gitattributes`](.gitattributes) states as `* text=auto eol=lf`. oxfmt
writes and *checks* for LF, so without that line a Windows clone under the
default `core.autocrlf=true` fails `npm run fmt:check` on every file, and
`npm run fmt` rewrites all of them into a diff `git diff` shows as empty.
`fmt:check` is a step in the `app` job of
[`test.yml`](.github/workflows/test.yml).

**One poll, two pages, one set of components.** A poll is read as an account
on `PollDetail` and through its link on `PublicPoll`, and an open poll is read
both ways by its own creator — so nearly everything a poll says about itself
has two callers reading two different pieces of state (`poll_status` and
`open_poll_view`). Anything both draw lives in `src/components/` and takes what
differs as a prop:

- `BallotCard` is the ballot. The two pages keep a small component each
  (`VoteForm`, `OpenBallot`) holding only where the scores go, because those
  are genuinely two paths with different grants (`submit_ballot` and
  `open_poll_submit`, over one `replace_scores()`).
- `PollNotices` holds the sentences about where a poll has got to; it takes
  which kind of poll it is as a prop, so the wording is written once.
- `NameRoster` is how the app answers *who*: who has voted, who has confirmed
  the options, and the invite list `Respondents` manages.

The rule: a poll must not describe itself differently depending on which door
the reader came in by. Copies drift, and the drift lands where nobody looks.

**Icons** come from `@phosphor-icons/react`, imported by name from the package
root (it is tree-shaken). Use the `Icon`-suffixed exports (`StarIcon`); the
bare names are deprecated.

**A button carries an icon** wherever it says something the word does not —
`leftSection`, 16px (14px on `xs` and compact buttons), always `aria-hidden`.
The same act gets the same glyph everywhere: a pencil for *Edit*, a plus for
adding, the counter-clockwise arrow for anything that puts something back
(*Restore*, *Keep*, *Add back to your list*), a lock for closing and an open
lock for reopening, a tick for anything that keeps what was just done
(*Done*, *Confirm options*, *Save changes*, *Save times*). **Cancel** carries
none: it is a way out rather than an act.

The one `<svg>` in `src/` is the QR code in `ShareQr.tsx`, generated from the
share link. `public/favicon.svg` is fetched by the browser.

**`auth.ts` and `AuthProvider.tsx` are split to keep hot reload working**: a
module exporting both a component and a hook cannot be hot-reloaded without
discarding its state, which for the auth context means being signed out on
every edit. `auth.ts` holds the context and `useAuth`; `AuthProvider.tsx` holds
the provider.

**The app is ChoiceLab**, served from the root of `choicelab.app`
(`base: '/'`), with hash routing so GitHub Pages needs no SPA fallback. A
poll's link is `https://choicelab.app/#/<id>`. The repository, the package and
the `star-voting:` prefix on every `localStorage` key keep the app's old name
(STAR Voting): renaming the keys would throw away every browser's voter keys,
drafts and settings. Two other things deliberately still carry it:

- `retireOldWorker` (`lib/serviceWorker.ts`) unregisters the service worker
  registered at the old `/star-voting/` path, which would otherwise keep
  serving a cached copy of the old app. `#/polls/new` still redirects to
  `#/new`, for installed copies holding the old shortcut.
- The manifest's `id` is `/star-voting/`; see [What the manifest
  says](#what-the-manifest-says).

**A one-segment address is a poll only if it is shaped like one.** The route
is `:pollId`, which outranks the catch-all, so `PollRoute` renders a poll only
when the segment is 22 characters of base64url, a uuid, or a `sample-` word
(`isPollParam` in `lib/pollId.ts`), and "page not found" otherwise. No page
name is any of those shapes. Signed out, `polls`, `new`, `settings` and
`sign-in` are named routes to the sign-in screen for the same reason.

[`site-root/`](site-root) is copied over the build in `dist/` by the deploy
workflow: `CNAME`, read by GitHub Pages to map the domain. It must never hold
an `index.html`. DNS for `choicelab.app` needs an `ANAME`/`ALIAS` record (or
GitHub Pages' four `A` records plus `AAAA`) — see [GitHub's custom domain
docs](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site)
— and **Settings → Pages** should show the domain with **Enforce HTTPS** on.

## One-time setup

### 1. Supabase

1. Create a project at [supabase.com](https://supabase.com) with **Enable Data
   API** on, **Automatically expose new tables** off (the migrations grant
   exactly what they need), and **Enable automatic RLS** on.
2. Connect it to this repo under **Project Settings → Integrations → GitHub**,
   with `main` as the production branch. Migrations are then applied for you —
   see [Database migrations](#database-migrations). The `anon` role's access
   is granted entirely by the migrations, and is limited to the `open_poll_*`
   functions and `send_contact_message` — it has no table grants.
3. Under **Project Settings → API**, copy the Project URL and `anon` key.
4. The **Email** provider is on by default. Two settings under it are not:
   - **Authentication → Email Templates → Magic Link**: replace the stock
     template with the one in [Signing in](#signing-in), which can send a
     link or a code.
   - **Authentication → Sign In / Providers → Email OTP Length** must equal
     `CODE_LENGTH` in `src/lib/signInMethod.ts` — the number of boxes the code
     screen draws. This project uses 8.
5. Under **Authentication → URL Configuration**, set the Site URL to
   `https://choicelab.app/` and add `http://localhost:5173/**` to the allowed
   redirect URLs. **The dev entry matters, and so does the `/**`**: the code
   sign-in carries its choice in a query parameter on the redirect address,
   and Supabase accepts an address only if its scheme and host match the Site
   URL or it matches a listed pattern. A refused address fails silently — see
   [Why the marker goes
   missing](#why-the-marker-goes-missing-and-why-it-goes-missing-quietly).
6. Under **Database → Extensions**, check that `pg_cron` is enabled. Without
   it the nightly purge is defined and never runs — see [Polls are deleted
   after six months](#polls-are-deleted-after-six-months).
7. Under **Authentication → Sign In / Providers**, turn on **Allow anonymous
   sign-ins** (what **Continue without an account** calls). Check the rate
   limit on anonymous sign-ins under **Authentication → Rate Limits**. Leave
   **CAPTCHA protection** off: once on, Supabase demands a token on every
   sign-in and the sign-in screen has no widget for one. See [Polls made
   without an account](#polls-made-without-an-account).

### 2. Local development

```bash
cp .env.example .env
# fill in VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
npm install
npm run dev
```

### 3. GitHub Pages deployment

1. Repo **Settings → Pages** → source **GitHub Actions**.
2. Repo **Settings → Secrets and variables → Actions** → add
   `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
3. Point the domain's DNS at GitHub Pages, then push to `main`.

### 4. Emails

Every email goes through [Resend](https://resend.com), called from inside
Postgres with `pg_net`:

- **an invitation**, when an address is added to an invite list
  (`send_invite_email` trigger) — one asking for options if the poll is still
  collecting them, one asking for a vote otherwise;
- **voting is open**, when a collecting poll opens (`notify_poll_opened`);
- **the results**, when a poll finishes (`notify_results_ready`);
- **a reminder to vote**, when the creator presses *Send reminder*
  (`send_poll_reminder`);
- **a contact message**, to the owner (see [The contact
  page](#the-contact-page)).

Who hears which is [What a poll writes to
people](#what-a-poll-writes-to-people).

The API key is read from Supabase Vault at send time and never committed. In
the dashboard's **SQL Editor** (not a migration):

```sql
select vault.create_secret('re_your_resend_api_key', 'resend_api_key');
```

Use a key scoped to sending only. To rotate it,
`select vault.update_secret(id, 'new_key_value') from vault.secrets where name = 'resend_api_key';`.
No redeploy is needed.

`send_poll_email` is the one place the app talks to a mailer. It checks for
`pg_net` and Vault first and quietly does nothing without them, which is what
the throwaway test database has. Emails are best-effort: never retried, and
never block or fail what triggered them. Invitations are sent per insert;
the other poll emails are sent once, when the poll crosses the line, so a
poll that opened or finished before the key existed is never announced.

An account can turn emails off from the gear menu (`send_poll_email` asks
`wants_email` first). The sign-in email is not affected. Every poll email's
footer links to `#/settings`, the one page holding the same switches as the
gear menu — a link cannot open a menu.

### 5. Push notifications

Optional. A build with no VAPID key has push switched off, and the database
sends nothing while the two Vault secrets below are missing.

1. **Make a VAPID key pair**: `npx web-push generate-vapid-keys`. Keep the
   private key out of the repo.
2. **Make a shared secret**, e.g. `openssl rand -hex 32`.
3. **Edge Function secrets** (dashboard → **Edge Functions → Secrets**):
   `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (e.g.
   `mailto:you@example.com`), and `PUSH_FUNCTION_SECRET` (step 2).
   `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided already.
4. **Vault**, in the SQL Editor:
   ```sql
   select vault.create_secret('https://<project-ref>.supabase.co/functions/v1/send-push', 'push_function_url');
   select vault.create_secret('<the secret from step 2>', 'push_function_secret');
   ```
5. **Deploy the function by hand.** Edge Functions are not deployed by the
   GitHub integration, and there is deliberately no workflow: it would need a
   Supabase personal access token in the repo's secrets, which reaches every
   project on the account. After any change under `supabase/functions/`:
   ```bash
   npx supabase login
   npx supabase functions deploy send-push --project-ref <project-ref> --no-verify-jwt
   ```
   **JWT verification must be off** for this function: the caller is the
   database, which holds no user token, and the function checks the shared
   secret instead. A merged change that is not deployed leaves the old
   function running, silently.
6. **The app's half**: Actions secret `VITE_VAPID_PUBLIC_KEY`, and the same
   line in `.env` for a local build.

To check it end to end: in two browsers on the built site, create an open
poll in one, turn push on from the gear menu in the other (signed out) and
vote, then close the poll from the first.
`select status_code, content from net._http_response order by created desc limit 5;`
shows what the function answered, and its logs are under **Edge Functions →
send-push → Logs**.

**Rotating the VAPID keys** strands every subscription made under the old
key. An account's device re-subscribes the next time the app opens
(`refreshAccountPush`); a watch on an open poll does not, and is dropped the
first time its push service refuses it.

## Database migrations

Schema changes live as SQL files in
[`supabase/migrations/`](supabase/migrations), named so they sort in run order.
Supabase's GitHub integration applies any new file that lands on `main`; check
the dashboard afterwards to confirm the run succeeded. Run `npm test` before
merging — it builds a database from these files, so it catches a migration
that does not apply as well as one that changes a result.

An applied migration is never re-run, so a mistake is fixed by a new
migration, not by editing the old file.

**A dropped function takes its grants with it, and a newly created one is
executable by `PUBLIC`.** Changing a function's argument list or `RETURNS
TABLE` means drop and recreate (`CREATE OR REPLACE` would add an overload or
refuse), so restate its grants and its `REVOKE ALL … FROM PUBLIC`. A missing
revoke is invisible in the schema; where it matters, a case asserts it.

### Trying one out, and taking it back

1. **`npm test`** rebuilds the throwaway database from scratch on every run,
   so editing a migration and re-running *is* the reversible loop.
2. **Transactional DDL**, against a database you want to keep (a scratch copy,
   a Supabase branch):
   ```sql
   begin;
   \i supabase/migrations/<file>.sql
   -- prove whatever you came to prove
   rollback;
   ```
   Everything these migrations do is transactional in Postgres
   (`CREATE INDEX CONCURRENTLY` and `ALTER TYPE … ADD VALUE` are not; neither
   is used).
3. **Another migration**, once one has shipped. There are no down files: they
   would be a second copy of every definition, exercised by nothing until the
   moment they were needed.

A migration that *repairs* drift between the live project and the repo copies
its definitions verbatim from the baseline, grants included, and must be a
no-op on a database that is already right. Check both by fingerprinting the
schema:

```sql
select md5(string_agg(x, '|' order by x)) from (
  select p.proname || ':' || pg_get_functiondef(p.oid) || ':' || coalesce(p.proacl::text, '')
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
  union all select 'col:' || table_name || '.' || column_name
    from information_schema.columns where table_schema = 'public'
  union all select 'con:' || conname from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace where n.nspname = 'public') s(x);
```

Run it against a build of the repo's migrations and against the live schema;
after the repair the two should match, and applying the repair to the first
should not move its number.

### Squashing

Occasionally collapse the history into one baseline:

```bash
scripts/squash.sh
```

Use the script, not `npx supabase migration squash --linked` directly. A
squash replays the migrations and pg_dumps the result, so **a statement that
does something rather than declaring something does not survive it** — a
backfill, a `cron.schedule()`, a policy outside the `public` schema. Those
live in [`supabase/after-squash.sql`](supabase/after-squash.sql), which the
script replays into a fresh migration on top of the new baseline; anything
there must be idempotent. `12_poll_retention` asserts the purge job exists, so
a squash that drops it fails the suite.

The script renames the baseline to `<version>_baseline.sql` (keeping the
version prefix, which is what Supabase's history is keyed on), runs
`npm test`, and prints `supabase migration list`. Commit the result on its
own, with no other changes.

**After a squash, make the remote's history match the directory before
anything else merges.** The integration refuses every run if the live project
has recorded a version with no file here (`Remote migration versions not found
in local migrations directory`), and a squash deletes exactly those files —
so unrepaired, nothing applies again, and later migrations can be folded into
the next baseline without ever having been applied. Read the printed
`supabase migration list` and run:

```bash
npx supabase migration repair --status reverted <each version with no file>
npx supabase migration repair --status applied <the baseline's version>
```

Both edit only `supabase_migrations.schema_migrations`. Mark the baseline
applied only if everything folded into it had been applied first.

A migration named in this file that is older than the baseline no longer
exists; refer to the behaviour, not the file.

### A version number is used once, ever

The integration records the number in front of a migration's name, and a
recorded number is never applied again, whatever file wears it later. **A
number is spent the moment it reaches `main`**: from then on, renumber rather
than replace, even if you believe the run failed. Before that — on a feature
branch — a migration can be rewritten, renamed or dropped freely. When unsure,
`git log origin/main -- supabase/migrations/<file>` says whether it merged and
`supabase migration list` whether the remote recorded it.

`npm test` cannot catch a skipped version: it builds from every file in the
directory, so it always tests the schema the repo *claims*. If the remote
falls behind, the fix is a new migration at a fresh number that re-asserts
the definitions from the baseline, checked as above.

## Tests

```bash
npm test              # every SQL case
test/run.sh runoff    # only cases whose filename matches "runoff"
```

The election logic can be wrong without looking wrong — a bad tie-break
produces a plausible winner — and it lives almost entirely in Postgres, so
that is where the tests are. `test/run.sh` builds a throwaway database from
`supabase/migrations/` (via `test/build-db.sh`, which `scripts/sample-poll.sh`
also uses), runs everything in `test/sql/cases/`, and reports each assertion.

It needs a Postgres server and a superuser role that can create databases.
`PGHOST`, `PGUSER` and friends are honoured; with none set it uses a local
cluster, starting it if it is installed and stopped, and otherwise prints the
install command for the platform. **Superuser** because every object is owned
by `postgres`: `test/sql/shim.sql` creates `postgres`, `anon`,
`authenticated` and `service_role`, and the SECURITY DEFINER functions run as
`postgres`. CI runs the same script against a `postgres` service container
([`test.yml`](.github/workflows/test.yml)).

That workflow has two more jobs. `app` runs `npm run lint`,
`npm run fmt:check`, `npm run test:unit` and `npm run build` (typecheck plus
bundle), with no Supabase secrets. `browser` runs the browser suite.

```bash
npm run test:unit     # vitest
```

**`test:unit` is for logic in the browser that can be wrong silently**, which
neither other suite reaches: the time-poll derivation (`schedule.ts`), the
timezone captions, `limits.test.ts` (which reads `supabase/migrations/` and
asserts every number in `limits.ts` is what the database enforces — the type
checker cannot see SQL and the SQL suite cannot see TypeScript), the push
encryption in `send-push/webpush.test.ts` (decrypted by an independent
RFC 8291 implementation, since a payload a browser cannot decrypt is dropped
while the push service answers 201), `readLedger.ts`, the CSV export, the coin
flip and similar pure modules. It is not a foothold for component tests.

### The browser suite

```bash
npm run test:e2e      # Playwright, desktop and phone, axe on every page it opens
```

`e2e/` runs the **built** app under `vite preview` in Chromium, because the
build is what ships (lazy chunks and the stale-build listener exist only
there). Every test runs at a desktop size and a phone size.

**It needs no database.** The Supabase address it is built with is a closed
port, and `e2e/fixtures.ts` fails any test whose page asks it anything, logs
an error, or throws. What it can reach: the home page, the sign-in screen, the
three explainer pages, the install guide, the intro, and the sample poll — which is
answered from a file and covers `PublicPoll`, both ballots, the question
strip, auto-advance, changing a vote and the results. **Not covered:**
anything behind an account or a write — the poll list, the create form,
`PollDetail`, the creator's controls. Reaching those needs `supabase start`
and Docker.

**Accessibility is checked on every page it opens**, in both colour schemes,
with axe at WCAG 2.1 A and AA plus best-practice rules; any finding fails the
test (`expectAccessible`). Interactive states that draw something new get
their own check. Announcements are asserted directly by reading the live
region.

Locally it needs the Chromium matching the pinned `@playwright/test`:
`npx playwright install chromium`, or set `PLAYWRIGHT_BROWSERS_PATH`.
`playwright-core` is pinned alongside because `@axe-core/playwright` takes it
as a peer, and an unpinned one does not typecheck. A failure leaves a trace
under `test-results/` (`npx playwright show-trace`); CI uploads them.

The e2e files are typechecked by `tsc -b` (`tsconfig.e2e.json`), which
catches a misspelt option in `test.use` that would otherwise be silently
ignored.

### How a case is written

Cases seed through `create_poll()` and `submit_ballot()` rather than inserting
rows, so they cannot construct a state the app could not produce, and each
rolls back at the end. A ballot set is a grid — one row per voter, one column
per option:

```sql
v_poll := tests.seed_poll(
  array['Apple', 'Banana'],
  array[[5, 4],      -- this voter scored Apple 5 and Banana 4
        [0, 1]]);
```

Assertions read the tally **by option name**, never by id or the runoff's
`a`/`b` labels: options that tie on points are ordered by id, so those labels
are not stable. `tests.prefers(t, 'Apple')` and friends in
`test/sql/helpers.sql` exist for this.

Expected values are worked out from the STAR rules by hand and written down
first — never copied from a passing run.

### What it does and does not cover

The SQL suite covers the tally end to end (score round, finalists, every
tie-break, the runoff, the genuine tie, the full ranking) and the rules around
it: the write paths, the option-list windows, confirming, reopening, revising,
the reveal gates on results and ballot sheets, the two readings of an open
poll, the poll list's paging, removed polls, who each email and push would go
to, live-update signal counts, the lock every writer takes, anonymous
accounts and their carry-over, and the retention purge. Each case's file name
says what it holds.

**Not covered:**

- RLS policies and `auth.jwt()`-gated access. The shim stands in for
  Supabase's `auth` schema with a one-row session table; a passing suite says
  which branch a function takes for a given `auth.uid()`, not who Supabase
  would let read a poll.
- Sending any email or push: there is no `pg_net` or Vault, so the suite says
  who *would* be told and never that anybody was.
- Delivering live updates: the shim keeps `realtime.send()`'s write to
  `realtime.messages` and drops the fan-out. `useLiveStream` has no harness.
- `run.sh` drops three extensions a stock Postgres lacks and the `MAINTAIN`
  privilege, none of which the tally touches. `pg_cron` guards itself, so
  retention is tested with no scheduler. Everything else is applied verbatim.

## Live updates

Poll pages hold a websocket and re-read themselves when the database says
something moved. [`src/lib/useLiveStream.ts`](src/lib/useLiveStream.ts) is the
listening half and documents its own rules. `broadcast_poll_change()` and the
triggers around it are the telling half. Realtime must be enabled on the
project and nothing else; broadcasting from the database writes to
`realtime.messages` and needs no publication or table grants. **Realtime →
Settings → Allow public access** can be off: nothing uses a public channel.

**A signal, not the data.** Every message is `{}`. It says a poll changed;
whoever hears it re-reads through the same RPC they would have called anyway.
That is why this needs no change to the access rules — `anon` still has no
table grants. Subscribing to row changes would have meant re-deriving every
access rule as an RLS policy.

**Anybody may listen; only the database may speak.** The one policy on
`realtime.messages` lets `anon` and `authenticated` receive on any `poll:`
topic, and on `user:<id>` only as that user. The database sends on
**private** channels (`announce()` passes `true` to `realtime.send`), clients
subscribe with `private: true`, and there is no INSERT policy, so no client
can send — otherwise anybody holding a link could broadcast `poll_deleted` to
everyone watching it. `broadcast_poll_change(uuid)` is revoked from `PUBLIC`
for the same reason. The policy lives outside `public`, which a squash does not
dump, so it is restated in [`after-squash.sql`](supabase/after-squash.sql);
`46_live_updates_are_received_not_sent` checks the flag and the policies.

There are two topics: `poll:<id>`, for every page watching one poll; and
`user:<id>`, for one person's poll list — every change to every poll on it
(made, invited to, or answered through a link). The list subscribes to its
reader rather than its rows because `user:<id>` is known from the session
before anything is read, so the list costs one request rather than read,
subscribe, read again. The cost is some wasted reads (a vote on page four
re-reads page one) and one `realtime.messages` row per reader per change.

Four rules govern the telling half:

- **Deletes are announced as loudly as inserts.** A page told only about
  arrivals would sit showing a tally that has been thrown away.
- **One change, one message — and a change is a transaction.** Triggers are
  statement-level, and `announce()` also remembers which topics (and events)
  it has sent to in the current transaction and drops repeats. That covers
  bulk writes such as `insert_options`, which loops a row at a time. It is
  safe because nothing reaches a listener before commit, and every message
  means only *re-read*.
- **A deleted poll says so.** Its own topic hears `poll_deleted`, the one
  event that is not a prompt to re-read: a re-read of a deleted poll fails,
  so `useLiveStream` hands it to the page's `onGone` instead and the page
  says the poll has been deleted. Pages with no `onGone` (the poll list) just
  re-read. The lists it was on are told on `user:<id>` by
  `broadcast_poll_gone`, a **BEFORE** DELETE row trigger, because its audience
  (`invited_voters`) cascades in the same statement. The cascading rows are
  silent (`broadcast_poll_change` returns early when the poll is gone). **The
  nightly purge is silent too**: `purge_old_polls` sets `app.purging_polls`
  and the trigger stands down.
- **A changed vote says nothing**, unless the voter's name changed. Nothing a
  watcher can see before the results unlock is derived from a score, and past
  the unlock no vote can change. There is no trigger on `scores` and none on
  `UPDATE` of `ballots`; `open_poll_revise` announces only a changed name.

**One funnel, and a page's own reads go through it.** `useLiveStream` returns
a `reread`, and every page-initiated read (a vote, a confirmation, a page
turn) goes through it, so the throttle applies to all of them and a burst
collapses into one trailing read. A page's own write echoes back as a
broadcast, and the messages are empty, so the echo cannot be told from
somebody else's change — but it can be accounted for. A broadcast is sent on
commit, so **a read that starts after a signal arrives already covers it**; a
signal that arrives while a read is in flight is not covered and is read for
when that read lands. [`readLedger.ts`](src/lib/readLedger.ts) is that rule,
in a module of its own so it can be tested (`readLedger.test.ts`): too
generous and a page shows overtaken votes, too mean and every press costs a
round trip. A subscription arriving reads unconditionally, because Realtime
replays nothing sent while the socket was down.

**There is no live indicator and no connection notice**, and no polling
fallback. A slow-to-join socket would trip a notice on ordinary page loads,
and the cost of a stalled socket is only a page catching up late; refreshing
is the fallback.

**The next question is read before it is opened.** On a multi-question poll,
`PollPage` holds the question on screen and the ones either side of it, each
subscribed and read by the same rule as any page. A neighbour's read is a
`poll_page`, kept in `ahead` and handed to the page as `prefetched` when that
question is opened, and drawn in a layout effect, so stepping to a neighbour
shows no skeleton. Each question's topic is held by one `QuestionWatch`
(`pages/PollPage.tsx`), keyed by the question, so walking from question 2 to 3
keeps 3's channel and opens 4's. (The Supabase client shares one channel per
topic, so two owners could not hold it anyway.) A question opened with nothing
held, or left after its signals went to the page rather than to `ahead`, gets
a read of its own. A question let go drops its held read.

**An open poll's live tick asks one function.** The creator's page reads an
open poll both ways, and `open_poll_view` contains everything `poll_status`
would say, so the page asks for the view and translates it
(`statusFromOpenView` in `src/lib/pollPage.ts`). Four status fields are
constants on an open poll: `invited_count` 0, `is_complete` false, `invited`
false, and `voted`/`confirmed` false — those ask about the account as an
invitee, and link ballots carry `account_id`, not `voter_id`. `expires_at` is
carried over from the read that opened the page, since it never changes.
`36_two_readings_of_one_open_poll` holds the two functions together field by
field.

In `npm run dev` every request appears twice (`StrictMode`), and against a
real project each is preceded by a CORS preflight. Count requests against
`npm run preview`.

## A poll that finds a time

A poll has a `kind`. `option` is a list somebody wrote, scored 0–5. `time` is
a poll looking for a meeting slot: the creator says how long the meeting is
and which UTC offset the poll is held at, then **paints a calendar** to say
which hours of which days are in bounds. Every window of that length that fits
inside the painting becomes an **option**, and voters rate the options by
painting the same calendar.

The enumeration happens in the browser at creation, and a voter's painting is
turned back into a score per option before it is sent. **The database stores
a time poll exactly as it stores any other** — rows in `candidates` and
`scores` — so the tally, RLS, the voter-key path, revision and live updates
are all untouched.

Example: a three-hour meeting, Monday to Friday, 08:00–22:00 painted on each.
Twenty-three window starts a day at half-hour steps, five days, 115 options.

**One gesture, three screens.** The creator paints which times the poll asks
about, a voter paints how good each is, and on a poll that collects its times
everybody paints which windows to offer. All three are
[`PaintCalendar`](src/components/PaintCalendar.tsx): one set of drag handlers,
one header, one set of rules.

### What is stored

`polls.kind` and `polls.schedule`, tied by a check constraint: `schedule` is
null if and only if `kind = 'option'`.

```json
{
  "timezone": "-07:00",
  "window": { "start": "09:00", "end": "22:00" },
  "desired_slots": 6,
  "granularity": 30
}
```

**Which days and hours a poll asks about are not stored.** They are exactly
the cells the options cover, so the browser reads them back off the option
list (`boundsOf`); stored bounds could disagree with the options. Unknown keys
in a schedule are stored and ignored by `validate_schedule`.

`window` is the one exception, because a grid needs a vertical axis: it is the
union of every day's hours at creation. Each calendar is drawn on `axisFor` —
that window **widened** by `spanOf` whatever is painted or offered outside it,
so a window collected later outside the original hours is still a row on
every grid. (A window off the axis would be an option nobody can see, rub out,
or score.)

A meeting's length is `desired_slots * granularity`. **Granularity is
derived** (`granularityFor`): half an hour under a day, a whole day at or above
one. A window may be longer than a day; `stepGranule` carries a cell into the
next date.

**A fixed UTC offset, never a named zone.** A named zone across a DST change
gives a day 23 or 25 hours and an ambiguous 1am. One poll, one offset;
`validate_schedule` refuses anything else. A poll running across a clock
change is an hour off the wall for its later days, and that is the trade.

**The picker offers offsets, captioned with a place**: `UTC-07:00 (Pacific
Time)`, or plain `UTC-07:15` where nobody keeps that clock. The caption is
worked out for the poll's own first day
([`timezones.ts`](src/lib/timezones.ts)) — `-07:00` is Pacific Time in July
and Mountain Time in January. Zones are listed in precedence order; within a
continent this picks the right name. The list is every whole hour from -12:00
to +14:00 plus every part-hour actually in use that day; an offset a poll is
already stored at is always kept. The ballot states the offset the same way —
`All times are UTC-07:00 (Pacific Time)` — derived on the spot rather than
stored, so it cannot drift. It is in brackets because the ballot line is
already a run of dotted clauses.

The **opening guess** is this browser's offset on the poll's first day, and
it follows the dates until the creator picks one (`offsetPicked` in
`CreatePoll`).

**An option's name is its window start in full ISO 8601**
(`2026-09-01T14:00:00-07:00`): unambiguous, unique within the poll (which
`insert_option`'s duplicate check needs), and sortable. It is formatted for
reading wherever shown.

**Only the two reads a ballot is drawn from carry `kind` and `schedule`**:
`poll_page`'s account branch and `open_poll_view`. `list_polls`,
`poll_status` and the rest do not need them — `formatWindow` works from the
name alone — and adding a column to a `RETURNS TABLE` means a drop and
recreate.

### The derivation

All of it is [`src/lib/schedule.ts`](src/lib/schedule.ts), pure and tested by
`npm run test:unit` — the only election logic not in Postgres.

**Creation.** Enumerate every start such that **every cell the window covers
was painted**. A gap in the painting is a gap in the options. A day painted
too short for one window contributes nothing, and the create form says so.

**Reading the bounds back.** `boundsOf` is the cells the options cover. It is
lossy at the edges, correctly: a cell no window covers is one a voter could
paint to no effect.

**Voting.** The voter paints a rating per granule; **a window's score is the
mean of its granules, rounded, held off both ends**: 5 only if every granule
is 5, 0 only if every granule is 0, otherwise 1–4. An untouched granule is 0.
A mean (rather than a minimum) ranks near misses, so a voter whose free
blocks are all shorter than the meeting still contributes; holding back the 5
stops a window with an impossible hour in it tying one that works.

**Reading a ballot back** (`paintingFromScores`). **A 0 vetoes** every granule
under it; **otherwise a granule takes the highest window covering it**. This
is exact for blocks at least a meeting long; anything shorter blurs, because
the scores do not carry it, so re-saving an unedited ballot can move a rating
a step. That is the cost of storing windows rather than granules.

### Making one

[`ScheduleFields`](src/components/ScheduleFields.tsx) asks for the meeting
length, the hours a whole-day fill lays down, and the offset, over one
`PaintCalendar`.

- **A day is in the poll exactly while something is painted on it.** There is
  no separate date picker; `daysOf(marked)` gives the days, and
  `ScheduleFields` reports the painting and the days through one callback.
- **The two time selects are a default, not the answer.** Clicking a day's
  heading lays them down; they are not stored, and moving them never changes
  what is already painted.
- **The grid is drawn between them** (`axisFor`), widened to hold anything
  painted outside them, so nothing painted is ever off the grid. To reach an
  hour outside them, move the select.
- **A poll cannot ask about a day that has gone.** The floor is today *on the
  poll's clock* (`todayIn`), not the reader's. Earlier days are greyed and
  take no gesture, and the arrows stop at the month holding today. The rest of
  today is not cut off. `CreatePoll` re-reads the floor when it counts and
  builds the windows (`fromDay`), so a form left open across midnight sends
  only valid days. `carryForward` uses the same clock.
- **Meeting lengths** run in half hours up to eight hours, then whole days
  (`MEETING_LENGTHS`); lengths in between are not real questions.

### The ballot

[`TimeBallotCard`](src/components/TimeBallotCard.tsx) sits beside
`BallotCard` rather than being a variant of it; what they share is
[`BallotFrame`](src/components/BallotFrame.tsx) — the card, the name box, the
question strip, the error line, Cancel and Submit, and the sending. Both
produce the same `BallotScore[]`, so both ballot paths work unchanged. The
ballot adds a six-value brush and the offset sentence to `PaintCalendar`.

The calendar is [`@mantine/schedule`](https://mantine.dev), an event calendar
rather than an availability grid; each gesture is a prop:

- `withDragSlotSelect` + `onSlotDragEnd` for a drag, and `onTimeSlotClick` for
  a single tap (the drag hook ignores a zero-length drag).
- Painted regions are rendered as **background** events coloured by rating.
- Out-of-bounds cells are disabled cell by cell through `getTimeSlotProps`.
- **A day's column heading fills that day**, through `onDateChange`.
- In the **month view**, `onDayClick` fills a day and a drag fills several.
- **The range in the header fills everything on screen** (`fillVisible`).

**The header is ours.** `DayView`, `WeekView` and `MonthView` are rendered
directly with `withHeader={false}` (the `Schedule` wrapper passes props each
view does not declare down to a `div`), under a row built from the library's
`ScheduleHeader` pieces: previous, the range, next, and a view switcher. With
the library's header off, the day heading is the only caller of `onDateChange`
in the week grid, so `onDateChange={fillDay}` has one meaning.
`labels={{ weekday: 'Fill the whole day' }}` gives the heading that accessible
name. Today and the current-time line are off (the grid is on the poll's
clock, not the reader's). The library's `todayControl` and `viewSelect` classes
are not used: they hide below 600px.

**The header's range is a control** and fills exactly what it names — the
month, the week or the day. It is exact because the month draws only its own
days (`withOutsideDays={false}`) and every grid starts its week on
`WEEK_STARTS_ON`, the same constant `visibleRange` counts from; keep those in
step.

**Every gesture toggles**: a stretch already exactly what the brush would make
it is cleared (`fillCells`, used by strokes, headings and the range alike).
The `Can't` brush never toggles.

**Changing the view holds the calendar still.** `showView` measures the
header's top before the switch and a `useLayoutEffect` scrolls by however far
it moved, so a shorter view does not leave the reader halfway down the page.
If the document is too short, the calendar is brought to the top instead.

**The time column is sticky** (`STICKY_TIMES`); the library's `weekViewInner`
is `overflow: hidden`, which has to be opened up or a sticky element has
nothing to stick to. **It is aligned to the rows** (`hoursColumn`): the library
draws one box per whole hour from the top of the grid, so on an axis starting
at, say, 14:30, the column is padded by the partial first hour and cut to the
grid's height. The day view also restores the first label's top border.

**Touch: sideways scrolls, downwards paints** (`PAN_SIDEWAYS`). The library
gives every slot `touch-action: none`; `pan-x pinch-zoom` on each slot hands
the sideways axis back to the browser. Greyed cells get `pan-x pan-y
pinch-zoom` (`outOfBoundsSlot`), since there is no stroke to keep the
vertical axis for. When the browser takes a gesture it fires `pointercancel`,
which the library's drag hook does not listen for, leaving a drag open that
the next `pointerup` anywhere would commit; `cancelled` sends a synthetic
`pointerup` on the next frame with a flag that stops it painting.

**The month gives up its drag on touch** (`withDragSlotSelect={!touch}`): a
drag across a month uses both axes, so there is none to hand to the browser,
and seven columns at the library's minimum width overflow a phone. Taps still
fill a day. `(pointer: coarse)` is read on the first render.

**Greyed stretches draw no row lines** (`NO_ROW_LINE`), so a greyed morning
is one block. The month is left alone: its days draw the outer frame.

**The ballot's arrows walk the poll** (`confine`): they step to the next range
with a day in bounds and are dead at the ends. The two painting screens are
unconfined.

**Every weekday is drawn on every view**; out-of-bounds days are greyed
(`outOfBounds`) rather than left out, which read as a broken calendar.

**The month view shows one chip per marked block** (e.g. `09:00–11:00`), at
the library's own cell height. **A tap on a chip clears what it covers**
(`onEventClick` → `erase`, via `granulesBetween`, tested against `runBounds`);
the chip sits over the day, so it is the only thing a second tap can reach.
Chip text colour comes from `inkFor`, because Mantine's resolver picks
unreadable ink at the dark end of the ramp.

**The ratings are a ramp of hue** — red through green, darkening along the
way — so neighbouring ratings are distinguishable and the ramp survives
colour blindness.

**Times are on one clock, which the reader picks.** *24-hour time* in the gear
menu applies to every time on screen. `toTimeOfDay` is the key string and
never changes; `formatTimeOfDay` is the one place the clocks differ. It is per
browser ([`lib/clock.ts`](src/lib/clock.ts), `star-voting:24-hour-time`) and
follows the browser's language until flipped (`PREFERS_24_HOUR`).

**Dates follow the browser's language, with no setting.**
[`lib/locale.ts`](src/lib/locale.ts) gives `WEEK_STARTS_ON` (from
`Intl.Locale` week info, or a CLDR region list where the browser lacks it) and
`DAY_BEFORE_MONTH` (`Fri Sep 18` vs `Fri 18 Sep`). Display only.

**Not shuffled.** `useBallotOrder` does not apply: a calendar's order is
chronological and load-bearing.

**Loaded lazily** through [`components/deferred.ts`](src/components/deferred.ts),
with its stylesheet imported inside it so Vite splits the CSS too.
`@mantine/schedule` and `rrule` are about 139 kB of JS and 79 kB of CSS,
fetched only by a time ballot or the create form. Because it arrives after the
page's own fade, it is **the one ballot with an entrance of its own**
(`BallotFrame`'s `arriving`), and the entrance wraps the body only — the name
box and question strip in `QuestionSkeleton` are real and must not fade.

### Reading the results

The tally is unchanged, and there is no heat map: a ranked list of times is a
legible answer. Option names are rewritten once on the payload by
`relabelResults` / `relabelRanking` / `relabelSheet`, so nothing downstream
needs a formatter. `formatWindow` recognises only the exact shape
`enumerateWindows` produces and returns anything else untouched, so it is
applied to every poll unconditionally.

**A window reads `2:00pm, Tue Sep 1`** — time first, since that is what tells
neighbouring windows apart; the date in the reader's own order. The end is not
shown: every window in a poll is the same length.

### The ballots, on the calendar

On a time poll `Ballots` and `YourBallot` draw
[`ScheduleBallots`](src/components/ScheduleBallots.tsx) instead of a grid or a
list:

- **Your ballot** is your painting rebuilt by `paintingFromScores`, on a
  read-only `PaintCalendar` (`mode="static"`, and a header whose range is a
  label).
- **The published sheet** is one calendar of everybody's ratings averaged cell
  by cell (`averagePainting`), with a `MultiSelect` choosing whose ballots go
  in, plus *Everyone* and *Clear* buttons. The average is over paintings, so a
  set of one voter is exactly that voter's calendar.
- **An average is shown by colour alone**, blended between the two ratings
  either side (`blendFor` in [`ratings.ts`](src/lib/ratings.ts)); the exact
  figure is a hover title. `eventBody` paints the blend, since the calendar
  tints off-theme colours.
- It is worked out in the browser from the sheet already read, so choosing
  voters costs no request and discloses nothing new. The CSV download is
  unchanged.
- The calendar is its own `lazy()` in `deferred.ts`, so an option poll's sheet
  fetches none of `@mantine/schedule`.

### Duplicating one

A duplicate of a time poll is a time poll. **Before the form appears,
[`DuplicateDates`](src/components/DuplicateDates.tsx) asks for the copy's
first day**, opening on `carryForward`'s answer — the source moved by the
fewest whole weeks that puts its first day on or after today (none if it is
still ahead) — and refusing past days. Every cell then moves by the same
number of days (`startingOn`), so spacing and hours come across whole. Several
time questions in one poll move together, from the earliest first day among
them. The offset copies across and sets `offsetPicked`.

The form **validates `schedule`** with `pollScheduleSchema` instead of casting
it, since it does arithmetic with it; one that does not parse leaves a time
poll with no grid and a line saying so.

A duplicated group copies each question as what it is, in one query:
`select('*, candidates(*)').eq('group_id', …)` (RLS lets anybody who can see
one question see its siblings).

### Ties, and the poll that elects nobody

Adjacent windows overlap, so the top two by score are usually neighbours;
that is accepted. **Painting whole days gives contiguous windows identical
score vectors**, which the score round settles randomly (by id) but the
runoff cannot: it has no random fallback, so two identical finalists are
`resolved_by: 'unresolved'` and the poll elects nobody.
`32_a_calendar_of_windows_tallies` asserts both cases. A last-resort ordering
in the runoff would fix it, but it is a change to every poll's tally and has
not been made.

### The option ceiling, and what the tally costs

The ceiling is 500 options per poll (`MAX_OPTIONS` in
[`limits.ts`](src/lib/limits.ts), `insert_option` and `insert_poll_row`). The
`UNIQUE (ballot_id, candidate_id)` constraint on `scores` already provides the
index the tie-break lookups use; do not add a duplicate. The tally is linear
in options and ballots: a tie of three or more is settled on five-star votes,
and head-to-head only ever compares one pair (see [Tie-breaks](#tie-breaks)).

### Collecting times, and a calendar among several questions

**A time poll may collect its times.** A voter adding an afternoon adds
several windows at once, so `insert_options` inserts a list atomically, and
each way into `candidates` has a plural door onto it: `suggest_options`,
`open_poll_suggest_options`, `creator_add_options`. **A name already on the
list is skipped rather than refused** by the plural functions (two voters
painting overlapping afternoons are not making a mistake); each returns how
many it added. The singular paths still refuse a duplicate.

The gesture is [`PaintTimes`](src/components/PaintTimes.tsx): the same
calendar, marking hours you would offer. Days are unconfined. It draws
`HoursFields`, the same two selects as the create form; they are this reader's
view and change nothing stored. Taking a window off the list is the creator's
job; other readers can only undo their own unsaved marks, by painting over
them (every gesture toggles).

**The calendar appears on *Add times*** (*Edit times* for the creator). Until
then the card shows a summary (`TimesSummary`, e.g. *5 options for 2 hours
from Fri Sep 4 to Sat Sep 5*). Pressing it starts an edit, which withdraws a
confirmation as opening a text field does. A save, or a *Confirm times* with
nothing painted, closes the calendar. On a time poll the card says *times*
where a text list says *options*.

**The edit is kept as a difference**: `PaintTimes` holds the cells this reader
marked and rubbed out, and draws the current list with those laid over it, so
somebody else's later suggestion is never mistaken for a removal. A window
being taken off is simply not drawn.

**A question of a group may be a calendar**: `create_poll_group` reads `kind`
and `schedule` per question, with the same checks `create_poll` applies.

**The creator may correct a time poll's options** through
`creator_add_options` (which takes painted windows), but not
`creator_add_option`, the typed-name path — a hand-typed name is one the
calendar cannot draw.

### Deliberately not built

- **A calendar heat map of the tally.** A ranked list is the answer.
- **Named timezones and DST-spanning polls.** Fixed offsets only.
- **Cross-timezone rendering.** Everyone sees one grid; the reader's own zone
  buys them one sentence (`offsetFromViewer`, "6 hours behind your clock").
- **Typing a time into a time poll.** Every window comes from a calendar.
- **Windows shorter than half an hour.**

## The winner is kept with the poll

A poll whose results are out has taken its last vote for as long as they stay
out, so its winner is fixed. `polls.winner_name` and `winner_settled_at` hold
it. `settle_winner()` fills them in when the poll crosses into having a result
and clears them when it goes back (**Reopen poll**), and `list_polls`,
`poll_status` and `open_poll_view` carry them. One election per result rather
than one per reader, and the badge is final on first paint; nothing about a
finished poll is cached in the browser.

**Two columns, because there are three answers**: settled with a name,
settled with none (a genuine tie, or closed with no votes), and not settled.
See `PollStatus` in [`types.ts`](src/lib/types.ts) and `PollStateBadge` in
[`PollTags.tsx`](src/components/PollTags.tsx).

**What settles it**: a poll closing, a ballot leaving, an invitee being
removed (three triggers), and the last ballot arriving — which is **a call at
the end of `submit_ballot` and `open_poll_submit`, not a trigger**. Both insert
the ballot row before its scores, so an `AFTER` trigger on `ballots` would
elect a winner from a tally whose deciding ballot had no scores.
`25_the_winner_kept_with_the_poll` guards this. A deferred constraint trigger
would fix the ordering but leave the invariant broken within the transaction,
which the test suite (one transaction per case) would see.

**Settling announces itself**: `settle_winner` writes every question in the
group, and that broadcast is how a reader on question 2 learns the poll
finished when the last vote landed on question 3. `results_announced_at` and
`reminder_sent_at` changing announce nothing; no page draws them.

## One read opens a poll

`poll_page(p_poll_id, p_voter_key)`, wrapped by
[`src/lib/pollPage.ts`](src/lib/pollPage.ts), answers *what may this reader
see here* and returns the page with it, tagged `account` / `open` /
`unreadable` (see `PollRead` in [`types.ts`](src/lib/types.ts) and `PollPage`
in [`PollPage.tsx`](src/pages/PollPage.tsx)). One request opens any poll,
including a signed-in reader holding the link to somebody else's open poll.

**Nothing here is a new privilege.** Each branch calls the functions that
already decide access — `poll_status`, `poll_group`, `open_poll_view`,
`open_poll_group`, `get_poll_results`, `open_poll_results`, `poll_ballots`,
`open_poll_ballots`, `poll_invitees`, `poll_ballot_scores`, `poll_is_removed` —
and visibility is `is_poll_creator` / `is_invited_to_poll`, the same functions
`polls_select` uses. One copy of every rule.

**It does not replace the narrow reads.** The live tick is still `poll_status`
alone on an invite poll (plus `open_poll_view` on an open one), because title,
terms and questions are frozen at creation.

**What the page draws rides along**: `results`, `ballots`, `invitees`,
`your_scores` (on an invite poll with private ballots) and `removed`, each
gated on exactly the condition its card is rendered behind, so a poll still
taking votes does not run STAR. **Null means "ask for yourself", not "there is
none"** — `results_available` alone says whether a result exists — which is
what keeps the cards right where no `poll_page` read is in hand (a poll that
finishes while watched, a crossing, the sample).
`44_your_ballot_on_the_page` holds the conditions.

**One gate over results and ballot sheets.** `poll_results_revealed` is
group-wide: a finished question inside an unfinished poll reveals nothing,
because early answers would steer late ones. Both ballot-sheet functions
refuse under it too, since a sheet of every ballot is the result in another
form.

**The cost is `FIRST_READ_MS`.** The route subscribes and reads on
`SUBSCRIBED`; on a network that blocks websockets that never comes, so the
poll waits for that floor before reading.

## Waiting

The first read of a page has nothing to show, so
`src/components/Skeletons.tsx` draws the shape of the page instead, and states
its own rules. Two lessons behind them:

- **A condition in the source is not the same as a case that happens.** The
  runoff card is conditional in code but always present on a tally (every
  question has at least two options), so `ResultsSkeleton` includes it.
- **A shape that guesses at nothing should not exist.** A skeleton survives
  only if something is still reachable holding nothing.

The app's boot, before the session is known, is the one spinner.

**One wait, one shape.** **A read is not drawn until the code for the cards
it will draw is in** (`preloadCards` in
[`deferred.ts`](src/components/deferred.ts), awaited by every `poll_page`
read), and **a card handed its data starts from it** (`useState(initial)`,
never an effect). The first needs the cards to be `deferred()` rather than
`lazy()`: `lazy()` suspends on first render however long ago the chunk
arrived, while `deferred()` hands a fetched chunk to `use` already settled.
`a finished poll goes from one skeleton straight to its results` in the
browser suite counts the shapes.

### When a wait ends badly

An uncaught render error unmounts the tree, leaving an empty `#root` that
looks like a slow page.
[`ErrorBoundary.tsx`](src/components/ErrorBoundary.tsx) says what happened and
offers a refresh, and that a refresh which does not help means the fault is
ours. It sits **above the router**, directly under `MantineProvider`, so it is
themed and `Layout` and the router are inside it; it does not reset on
navigation. Its most common catch is [a stale build](#a-deploy-takes-the-old-build-with-it)
whose reload has already been spent.

## Accessibility

Held to WCAG 2.1 AA and checked by axe on every page the browser suite opens.
The rules below are decided in one place each, not at call sites.

**Contrast is the theme's job** (`main.tsx`):

- **Filled colours are shade 8** in both schemes (`primaryShade`), with white
  text. Orange, green and yellow are too light for white at any useful shade,
  so where one is filled (the open question in `QuestionStrip`, the orange
  confirm buttons) it is shade 4 with `autoContrast` (dark text). Colours come
  from Mantine's palette only. The score round's also-ran bars use
  `--muted-bar`.
- **Dimmed text** is a grey of its own per scheme (`cssVariablesResolver`),
  the lightest that clears 4.5:1 on every surface it appears on.
- **Light badges and subtle buttons** take their colour's shade 9 darkened
  just enough to clear 4.5:1 on the hover shade.

**A link inside a sentence is underlined**
(`.mantine-Anchor-root[data-inherit]` in index.css): colour alone may not mark
it.

**One `h1` per page, no skipped levels.** The page's title is the `h1` (drawn
at `h2` size); headings over cards are `h2`s at `h4` size. The header wordmark
is not a heading. The sign-in card and the intro, outside the app shell, are
each their own `<main>`.

**Every page names its tab** (`usePageTitle`): the poll's title, or a word or
two, with no site suffix. A poll's title is set by `PollHeading` alone.

**What changes without a page load is announced** (`announce`, and the two
live regions `Announcer` mounts):

- a change of page announces the new title;
- moving between questions announces *Question 2 of 3: …*;
- on a poll's own page, its state and count when they change (not on arrival,
  and not on the poll list);
- a copied link, a poll removed or restored.

Toasts are already `role="alert"`, as is every red error line. A create form
refused on submit moves focus to the first invalid field.

**The question strip says in words what its colours say**: each question has a
hidden *(answered)* or *(not answered)*, and the open one is `aria-current`.

## Motion

**An animation has to answer a question the reader would otherwise have to
work out.** A star draining to zero says a score was cleared rather than a tap
missed; a bar growing makes the comparison happen on screen; a page fading in
says the last one was left. Anything merely pleasant is out, with the narrow
exception under [Smaller movements](#smaller-movements).

The scale is five durations and one curve on `:root` in `src/index.css`:
`--motion-fast` (120ms) for feedback on a press, `--motion-base` (200ms) for
something arriving or leaving, `--motion-resize` (320ms) for a card changing
height, `--motion-slow` (500ms) for things meant to be watched (results bars,
the runoff chart), and `--motion-travel` (450ms) for something crossing the
screen (the heading flight, a question's slide). Durations are always picked
from these. JavaScript reads them off the document (`lib/motion.ts`); the
exceptions are Mantine's transition durations in `main.tsx` and the runoff
chart in `Results.tsx`, which take numbers and say so.

**Reduced motion turns all of it off**, in three places for three kinds of
motion: one rule over the stylesheet in `index.css`, `respectReducedMotion`
in the theme for Mantine, and `prefersReducedMotion` / `useReducedMotion`
wherever motion is started from JavaScript.

`src/components/Reveal.tsx` is the one entrance everything arrives by.

Rules learned the hard way:

- **A control must never make the reader wait to see what they just did.**
  Stars fill instantly; only emptying is swept, left to right, so the first
  star answers on the frame of the press.
- **A transition takes its delay from the state it is arriving at**, so the
  sweep delays hang off `.star` and `.star[data-filled]` rather than a
  direction on the group (`StarRating.module.css`).
- **`Reveal` is a box, and a box inside a `Stack` is spaced as one item.**
  Wrap one element, never several.
- **Mounting again is not being different.** A crossing between questions
  re-mounts the card under the strip, but the strip has not changed, so a
  crossing does not replay an entrance; only the question's half slides (see
  below).
- **A transition needs the start value to have been painted.** The results
  bars wait two animation frames between empty and full (`Results.tsx`).
- **The route's entrance is keyed by `pageKey()`, not `pathname`**, so walking
  between questions does not re-mount the poll.

### A poll's heading flies between the list and its page

Opening a poll from the list flies its heading from the card to the top of
the poll's page ([`lib/headingFlight.ts`](src/lib/headingFlight.ts)); the
page's **Your polls** control, and the browser's back and forward buttons, fly
it back. Each part — title, state badge, description, creator, tags — flies to
its own counterpart. It answers *is this the poll I tapped?*, and it is also
how the page waits:

1. The press measures the card's heading, part by part, and navigates.
2. The poll's page starts blank with only the heading in the air; it is laid
   out invisibly so the heading has somewhere to aim, and the poll is read
   underneath as usual.
3. When the heading lands, whatever has arrived fades in: the poll if the
   read is back (no skeleton is ever drawn), its skeleton if not.
4. A skeleton that has gone up stays for at least `SKELETON_MIN_MS`
   (`pages/PollPage.tsx`), so it never flickers.

How it works:

- **Copies, not a View Transition**, because a view transition freezes the
  page while the next one is prepared, so nothing could load during it. Each
  part flies as a fixed-position copy of its destination, animated backwards
  from where it took off (FLIP) with `Element.animate`.
- **The page has a heading to land on before it has read the poll**: the card
  passes everything the heading is drawn from in navigation state
  (`heading`), and `PollPageSkeleton` draws a real `PollHeading` from it. On
  landing each copy moves onto its real counterpart if they disagree and fades
  out once the page has faded in.
- **Parts are found by `PollHeading`'s marks** (`data-heading`,
  `data-heading-row`, `data-heading-part`), so both ends need only be a
  `PollHeading`, compact on the card.
- **The title's words fly, not its box** (`PollTitleText`), so a short title
  is not scaled by the space around it.
- **The page's own entrance stands down** (`stillEntrances`, finding
  `Reveal`'s `data-reveal`; `Reveal`'s `rise`), so the landing is not aimed at
  a page still rising.
- **`scrollbar-gutter: stable`** on `html` stops the content shifting when a
  long page lands under a short one.

**`BackToList` is on every poll page of a reader who has a list.** It lands
on the card of the group's first question and goes *to* the list rather than
back through history. It only flies when there is a cached list to land on.

**Browser back and forward fly too.** The address moves first, so the page
being left measures its heading in a layout effect's cleanup (`departing`),
and both ends look for their flight in a layout effect on mount. A departure
does not fly when a flight is already under way, when the browser drew its
own transition (`hasUAVisualTransition` on `popstate`, heard ahead of the
router), or when the heading is scrolled out of sight. The list takes a
returning flight only from its own way back or the back button
(`returnFlight`), not from the wordmark.

**The list comes back as it was left** ([`lib/listCache.ts`](src/lib/listCache.ts)):
same page, same rows, same scroll, so the heading has a card to land on. Only
a return draws from it; the list still subscribes and reads as usual. **A poll
page reads the first page of the list in the background** when nothing is kept
or the kept first page lacks this poll (`keepListFor`) — a poll just made, a
poll reached by its link, a tab reloaded — so the way back from those flies
too. If the card is gone, nothing flies.

Skipped under reduced motion and where there is no `Element.animate`.

### A question slides along a row

Moving between questions pushes the old question out one side and the new one
in from the other — next from the right, previous from the left
([`lib/questionSlide.ts`](src/lib/questionSlide.ts)). `QuestionStrip` drives
it. **What slides is everything after the strip and its rule**: the strip and
the rule under it (which `QuestionStrip` draws and marks
`data-question-rule`) stay still. Where the strip stands over a finished
question's tally, the two are wrapped in their own stack.

- **A push the whole width of the box**, both questions edge to edge, clipped
  to the box the question is drawn in (the card, or in a column a `clip-path`
  on each arriving piece). The leaving copy fades late, in case the new
  question is shorter.
- **The leaving question is a copy**, taken in a layout effect's cleanup as
  the strip unmounts. A strip that stays mounted across a crossing does not
  copy.
- **One slide in, however many times the question is redrawn.** The strip
  joins whatever follows it on every render, and a `MutationObserver` joins
  anything added during the crossing. Every piece is started from the same
  moment on the animation timeline (`timelineNow`), so they move as one.
- `AppShell.Main` is `overflow-x: clip` (not `hidden`, which would break
  sticky children) so a block sliding in does not widen the page.
- **On `PollDetail`, nothing under the question is drawn during a crossing**
  (they wait for `showing`), since the question's height is unknown until the
  read lands.
- **The stand-in guesses from what is known.** Neighbours are read ahead, so
  only a jump further along waits. On an invite poll the strip knows each
  question's option count, and `tallied` says whether every question has a
  tally. Otherwise the question being left is the guess.
- **A crossing is one read**: `PublicPoll` reads the question it is crossing
  to through `poll_page`, which carries the tally, rather than
  `open_poll_view`, which does not.

### Smaller movements

One movement is pure decoration, allowed because it makes the app read as one
thing and costs nothing: **the open question's highlight crossfades**
(`fadeMarks`) in step with the slide. The rest answer a question:

- **Confirming the options turns the button green**
  (`CollectOptions.module.css`): one button changing in place, with a tick
  pop counted only from changes seen while on screen; it fades back when an
  edit withdraws the confirmation.
- **A count rolls over** (`roll` in `PollTags.module.css`) when the count
  badge's words change.
- **A name lands in a roster** (`badgeArrival.module.css`): a voter or
  confirmation joining `NameRoster`, or an invitee's badge in `Respondents`
  turning to *Voted* or *Confirmed*, pops in with its colours inverted and
  fading back, so the reader can find who just answered. Only changes seen on
  screen count (`useArrivals`), never the first read. A name joining
  `NameRoster` goes on the end (`useArrivalOrder`) rather than into its
  alphabetical place, which would shift everyone after it; a fresh read is
  alphabetical again.
- **Progress bars grow** at `--motion-slow` (`.mantine-Progress-section` in
  `index.css`).
- **A card that replaces a card changes height smoothly**
  ([`SmoothHeight`](src/components/SmoothHeight.tsx)), around the question's
  half of `PollDetail` and the vote card of `OpenPollPanel`. Content changes at
  once and the card's frame moves, its contents clipped to it; elsewhere the
  block's height moves, clipped. Swaps are detected with a `MutationObserver`
  (delivered before paint), since most are decided inside a card.
  `data-own-height` lets an inner one, or the calendar, opt out.
- **The poll list closes up and turns** ([`PollCards`](src/components/PollCards.tsx)):
  FLIP within a page, so a removed card fades while the rest slide up; a page
  turn uses the question slide's push ([`carousel.ts`](src/lib/carousel.ts)).
  Cards are keyed by the page their rows are of, set in the same render as
  the rows.
- **The answer card pulses once as it arrives** (`landed` in
  `Results.module.css`): a fade and one ring.
- **A new poll's title flies from the form** (`launchTitleFlight`) — from the
  title field, or from the Create button if the field is scrolled away.

## A deploy takes the old build with it

Each deploy replaces the whole Pages artifact, so every hashed filename of the
previous build stops resolving. A tab loaded before the deploy keeps asking
for those names until it reloads — which on a phone or the installed app can
be days. The first lazy chunk it reaches for (usually `Results`, the first
time a poll finishes) 404s, GitHub Pages answers with HTML, and React
unmounts the tree.

**[`lib/staleBuild.ts`](src/lib/staleBuild.ts) reloads the page** on
`vite:preloadError`, which Vite dispatches for any failed dynamic import or
split stylesheet, so new `lazy()` calls are covered automatically. The page is
fetched network-first, so the reload gets the current build; hash routing
keeps the address. Not live under `vite dev`.

**The loop guard:** a reload that does not fix the import would reload
forever. A second failure within `LOOP_WINDOW_MS` of a recorded reload is left
alone (and caught by `ErrorBoundary`); one later is the next deploy. The
marker is in `sessionStorage`, per tab, and **if it cannot be written, there
is no reload at all**.

## Installing it to a home screen

The app is installable on Android, desktop Chrome and iOS (Share → Add to
Home Screen), opening standalone. Three files:

- **[`public/manifest.webmanifest`](public/manifest.webmanifest)**: name,
  icons, `display: standalone`, and `start_url` / `scope` of `./` (relative to
  the manifest). With hash routing every address is in scope, so a share link
  opens in the installed window.
- **[`public/sw.js`](public/sw.js)**: required for the install prompt and for
  push. It caches the shell (HTML, hashed bundle and stylesheet, icons) and
  **never anything off-origin** — a cached poll read is a wrong poll read.
  Offline shows the app saying it cannot reach the server. **It leaves video
  alone**: videos are fetched in byte ranges, and Safari will not play a whole
  cached file handed to a range request.
- **[`index.html`](index.html)**: `<link rel="manifest">` and the `apple-`
  tags, which iOS still needs (it takes the home-screen name from
  `apple-mobile-web-app-title`).

`src/lib/serviceWorker.ts` registers the worker in the built app only — a
worker caching dev-server modules serves the previous edit. Use
`npm run build && npm run preview`, and DevTools → Application to see why
Chrome thinks the app is or is not installable.

**Bump `VERSION` in `sw.js` whenever that file changes.** The cache is named
after it and the new worker deletes every other cache on activate. Nothing
else needs bumping: hashed assets have new names, and the page itself is
fetched network-first.

### What the manifest says

- **`id` is `/star-voting/`. Leave it alone.** It is an identifier, not an
  address; changing it makes every installed copy a stranger to the app.
  Whether a copy installed at the old path follows the app to the root is up
  to the browser (Chromium does; iOS keeps the address it was added from).
- **`shortcuts`** — *New poll* and *Your polls* (`#/polls`) — each with an icon in
  `public/shortcuts/` (the app's gradient behind Phosphor's bold `Plus` and
  `ListBullets`, as rounded `any` and full-bleed `maskable` PNGs). Without an
  icon Android draws a grey square. Redraw them if the logo's colours change.
- **`launch_handler: focus-existing`**: opening the app while it is open
  brings that window forward. The launch is handed to the page, which routes
  itself (`useLaunchRoutes` in [`lib/launch.ts`](src/lib/launch.ts)) — except
  a launch with no route (the icon), which leaves the open page alone.
  Chromium only. Notification taps are routed by the service worker.
- **`screenshots`**, for Chromium's richer install sheet, taken from the
  sample poll by `npm run screenshots`
  ([`e2e/screenshots.capture.ts`](e2e/screenshots.capture.ts)). The browser
  suite checks the declared sizes against the files, since a wrong size is
  silently ignored.

### The icons

`public/icon-192.png`, `icon-512.png`, `icon-maskable-512.png` and
`apple-touch-icon.png` (180px) are the star of `favicon.svg` on a diagonal
gradient from `#7d14ff` to `#47bfff`, as in `public/logo.png`:

- the two `any` icons have rounded corners and are transparent outside them;
- the **maskable** one is square and full-bleed with the star inside the
  middle 80%, since Android crops it to the launcher's shape;
- the **apple-touch-icon** is square and opaque: iOS applies its own mask and
  composites transparency onto black.

### The colour of the status bar

Installed, the strip behind the status bar is `<meta name="theme-color">`. It
cannot use the media-query form, because the app's theme menu can disagree
with the OS. The inline script in `index.html` sets it from the stored choice
before first paint, and `ThemeColorMeta.tsx` keeps it in step, both writing
the `--mantine-color-body` value for the scheme spelled out.

### The install button

`InstallButton.tsx` in the header. Chromium's `beforeinstallprompt` arrives on
its own schedule, often before React mounts, so `src/lib/installPrompt.ts`
catches and holds it at module scope. The button draws nothing where there is
no prompt (iOS, an installed window, an undecided browser), and sits beside
the theme menu so its absence leaves no gap. The sign-in screen has no header
and so no button.

## The intro

`#/intro` is a film of the app at work, about fifty seconds: the logo
arrives and flies into the header of a recording of the real app, which makes
a poll, gathers films from friends, rates them, paints a calendar, watches the
votes arrive, closes the poll for both results and goes back to the poll list;
then the logo flies back out and the page ends on **Back to homepage** (`/`),
**Make your own poll** (`/new`), **Share this intro**, and a carousel of what
the film had no time for. It is public and outside the app shell (the footage
has the header in it). [`pages/Intro.tsx`](src/pages/Intro.tsx) is the page;
the film is under [`components/intro/`](src/components/intro).

- **The footage is a recording, not a drawing**, made on the live site by
  [`scripts/intro/record.mjs`](scripts/intro/record.mjs) and committed to
  `public/intro/` (an mp4 and a poster per shape). Re-record when the create
  form, the collecting card, either ballot, the results or the list change
  visibly; nothing reminds you. See [Recording the
  intro](#recording-the-intro).
- **One section at a time.** `sections.json` names each section, gives its
  caption and its length in the film; the film draws the caption and a bar per
  section above the footage. Nothing pans or zooms.
- **Every frame is a function of `T`**, the seconds since the start, with
  nothing animated through CSS. A `requestAnimationFrame` loop advances `T`
  (capped at a tenth of a second per step), **except while the footage plays,
  when `T` follows the video's playhead** (`followVideo` in `Intro.tsx`): a
  video that stops to buffer holds the film with it. A clock that has moved
  where the video is not — **Skip** (`T = TOTAL`), **Watch again**, a rotation
  handing over to the other shape's video — seeks the video to it. Reduced
  motion starts on the last frame and fetches no footage; a video that will
  not play leaves the film running past a still.
- **Two cuts, by window shape, on one timeline**: landscape at 1920×1080 (a
  browser window) and portrait at 1080×1920 (a phone). The recorder fits each
  section of both to the length `sections.json` gives it, so rotating swaps
  videos at the same moment without restarting.
- **The logo's flights land on the footage's own header logo**, whose
  position the recorder writes to `footage.json`, so the film reads as the
  app opening and closing. **There is only ever one logo**: the screen fades
  in around the landed logo (`LANDED` to `FOOTAGE`) and out from around it
  before it flies, and never moves while the two overlap.
- **It stays light in dark mode**, as a video would; the page takes the film's
  background. The buttons are styled to look the same in both schemes.
- **Fully transparent parts are hidden outright** (`seen` in `Film.tsx`), so
  axe does not measure the contrast of a caption nobody can see.
- **The buttons and the carousel are drawn at page size, over the film**, in
  the space under the closing wordmark (`FILMS[…].actions`; higher on the
  tall shape, where three stacked buttons and the carousel must fit), hidden
  (not just transparent) until they rise in.
- **The carousel** ([`Features.tsx`](src/components/intro/Features.tsx))
  turns every four seconds from the moment it rises in, and stops for the
  pointer, for focus, for **Pause** and for either arrow; under reduced
  motion it does not turn and has no pause. Paused, the card is a live region.
  Each feature is a word and a sentence a newcomer might be weighing the site
  on; keep them true.
- **Make your own poll asks nothing**: a reader with no session gets one
  without an account (`continueWithoutAccount`) and is taken to the create
  form.
- **Share this intro** opens the share sheet where there is one and copies
  the link otherwise.

### Recording the intro

The footage is the real app on `choicelab.app`, driven by Playwright in Edge
signed in as a test account, with a poll filled by scripted strangers calling
the open-poll functions with the public anon key. Edge rather than
Playwright's own Chromium, which some Windows machines block. Nothing here
needs Docker.

```bash
node scripts/intro/browser.mjs                       # leave running; sign in once
node scripts/intro/seed.mjs                          # once per account: the list's example polls
node scripts/intro/record.mjs test-results/intro-landscape --publish
node scripts/intro/record.mjs test-results/intro-portrait --portrait --publish
```

- **The capture browser keeps its own profile** in `.capture-profile/`
  (gitignored, and ignored by Vite's watcher, which crashes on its locked
  files). It holds the test account's session; sign in with a code.
- **The window must stay visible while recording**: Edge stops drawing
  frames for a covered window.
- **A take makes one poll, "Movie night", and deletes it** at the end, and
  deletes any left by a take that crashed. The example polls stay.
- **Frames come from the screencast** (Playwright's own video blurs text) and
  are put together by `ffmpeg`, on the PATH. A cut in the recording (the
  selects set off camera, the reload that shows the results fresh) is a cut,
  not a wait. Each section is then sped up evenly or held on its last frame to
  its length in `sections.json`.
- **The page is dressed for the camera**: an arrow, or on the phone a
  fingertip shown only while pressing; toasts hidden; the account's address
  hidden in the header and shown as *you@example.com* elsewhere.
- **Every scroll is a glide on camera.** A click near the edge scrolls the
  element into view first, easing, sideways too where a box scrolls (the week
  calendar on a phone); Playwright's own jump before a click is never used.
- **The second question's windows are scored differently by each stranger**,
  since identical score vectors tie the runoff (see [Ties, and the poll that
  elects nobody](#ties-and-the-poll-that-elects-nobody)).
- Node on Windows sometimes dies at exit with a libuv assertion; run the take
  again.

## The home page

`/` is the front door for everybody, signed in or not: **Better group
decisions** over *using STAR voting*, a ballot being scored, one sentence, and
twelve tiles in pairs — the intro and a new poll, signing in (or out) and the
reader's polls, what STAR is and why use it, the sample poll and its result,
installing the app (the code, once it is installed) and the features, contact
and donate. [`pages/Home.tsx`](src/pages/Home.tsx)
is the page.

- **It is the one page that links to the others.** The header's wordmark goes
  here; the header's right-hand group holds only settings (install, the gear's
  switches, the theme), and the gear menu holds no pages. Signing in and out is
  a tile, not a header control: nobody does it mid-poll.
- **Every other page leads back to it.** `Layout` draws **Back to homepage**
  (`BackToHome`, drawn exactly as `BackToList`) above every page in the
  shell but the home page, the polls, and the poll list — which draws it in
  one row with *Archived* (just its icon on a phone) and *New poll* together
  on the right, its heading kept for screen readers; the archived view goes
  back to the list.
  A poll draws its
  own: **Your polls** for a reader with a list (the list is one step nearer
  home and leads back here), **Back to homepage** for anybody else and on the
  sample. The sign-in screen and the intro, outside the shell, carry their
  own.
- **Two tiles to a row on every screen**, so each is an icon and a word or
  two, and lifts by a pixel under the pointer as a poll list card does. A
  whole tile is the link; *New poll* without a session and *Sign
  out* are buttons (`useMakePoll`; a confirming modal).
- **The poll list is `/polls`.** Signed out, `/polls`, `/new`,
  `/settings` and `/sign-in` are the sign-in screen; it stashes where to go
  next (the poll a refused reader came from, or `/polls` from its own
  address), since a magic link lands on `/`.
- **The ballot is [`StarLoop`](src/components/StarLoop.tsx)**: four options,
  three voters, eighteen seconds round. Like the intro, every frame is a
  function of `T` advanced by `requestAnimationFrame`, drawn on a fixed
  1280×600 stage scaled to its box; it stops while out of sight, and under
  reduced motion it is one still frame of a filled-in ballot. Decorative
  (`aria-hidden`): the sentence under it says what it shows.
- **The explainers are three pages** — `/star`, `/why-star`, `/features` —
  in [`pages/Learn.tsx`](src/pages/Learn.tsx), one lazy chunk. The first two
  are drawn as the results page is, a heading over each card, and work an
  example election through emoji tables computed from its ratings. *App
  features* links the install guide.

## The donate page

`#/donate` asks readers to give to Khan Academy rather than to the site. It is
public and reached from the home page.

**The button goes to an Every.org fundraiser** (`EVERY_ORG` in
[`lib/donate.ts`](src/lib/donate.ts)), because a fundraiser can report what it
has raised and from how many people. The page reads that once, from
`GET partners.every.org/v0.2/nonprofit/<slug>/fundraiser/<slug>/raised` with
the *publishable* key. `raised` and `goalAmount` come back as strings, in
cents. The goal is a bar; where `goalType` is `AUTOMATIC` it is a moving
"smart milestone", so the page calls it the next milestone. With no
fundraiser or key, the button gives to the charity directly and no count is
drawn; a count that fails is left out. Everything in `EVERY_ORG` is public, so
it is in source rather than `.env`. The browser suite answers the API itself
(`e2e/fixtures.ts`).

The logo is `public/khan-academy.png` (192px, from Every.org's `logoUrl`), kept
locally and drawn as a rounded tile because it is opaque white. Changing the
charity means changing that file, the page's name and description, and
`EVERY_ORG`.

**The signature** under the note is Caveat, cut to the five characters of
"— Rob" (three kilobytes, in `src/assets/fonts/` with its licence) and loaded
only by the `Signature` component the donate and contact pages share. Any
other character falls back to a system cursive; `Signature.module.css` says
how to recut it.

**The tax note was checked; check it again before changing it.** From 2026 a
US taxpayer who does not itemize can deduct up to $1,000 of *cash* gifts to
charity ($2,000 jointly), excluding gifts to donor-advised funds. Every.org is
a 501(c)(3) public charity, and an ordinary donation through it is a
contribution to Every.org (only its optional DAF accounts are a DAF). So a
card, bank, PayPal or Venmo gift counts; stock, crypto or a DAF gift does not.
The note says the first half and leaves the rest to the word "cash". If
Every.org's terms or the rule change, this note becomes untrue.

## The contact page

`#/contact` is a reply address and a message, under a signed note, with a
link to GitHub's new-issue form. Public, reached from the home page.

**A message is a row and an email, and nothing in the app reads it back.**
`send_contact_message` emails it to the owner (`send_contact_email`, with the
sender's address as Reply-To) and stores it in `contact_messages`, which has
RLS on, no policies and no grants. Read it from the dashboard:

```sql
select created_at, email, message from contact_messages order by created_at desc;
```

**`anon` may call it** — the one non-`open_poll_*` function `anon` holds —
because the reader most likely to hit a bug is a voter holding a link. The
bounds are in the function: the lengths in `limits.ts`, the address shape
`invited_voters_email_ck` uses, five messages a day per session, and ten an
hour from everybody together. The last is the only bound on a caller with no
session, and is low so a script cannot use up the Resend key every poll email
shares. The address is filled in from the account where there is one. The
email is best-effort; the table is the record. `45_contact_messages` covers it.

## Link previews

Chat apps draw a card from the Open Graph tags in [`index.html`](index.html):
the title, the byline *Better group decisions*, and `logo.png` as a
`summary` card (opaque, since some clients composite transparency onto black).
The crawler runs no JavaScript.

**Every poll link gets the same card**: the part after `#` never leaves the
browser, so GitHub Pages serves one `index.html` for every poll. A card per
poll would need the id in the path and a server answering it.

**There is no `og:url`**: it would be the app root with the fragment gone, so
Facebook would group and link every poll share to the poll list.

Crawlers cache; Facebook's for weeks. Use [Facebook's Sharing
Debugger](https://developers.facebook.com/tools/debug/) to refresh it.

## Push notifications

Push sends the same moments as email — being invited, voting opening, the
results, a reminder — on a second channel, and it is the only channel that
reaches an open poll's voters who gave no address. The database half is in
the baseline,
[`supabase/functions/send-push`](supabase/functions/send-push) is the sending
half, [`src/lib/push.ts`](src/lib/push.ts) the browser's, and `push` /
`notificationclick` at the foot of [`public/sw.js`](public/sw.js) the part
that runs while the app is closed. Setup is [step 5](#5-push-notifications).

**No new rules about who is told.** Every push goes to exactly the people the
matching email goes to, from the same `poll_email_audience` /
`poll_results_audience`, called from the same triggers, so *nobody is told
what they just did* and the once-only claims hold on both channels.
`poll_push_targets` is what the suite asks.

**A browser reaches the database one of two ways:**

- **Bound to an account** (`push_subscriptions`, via
  `save_push_subscription`), by turning on the push switch in the gear menu.
  It hears every poll the account is in while the account wants push. An
  endpoint belongs to one account at a time, and **signing out forgets it**
  (`forgetAccountPush`, before the session goes), so a shared browser does not
  buzz with the last person's polls.
- **Watching one open poll** (`poll_push_watches`, via `open_poll_watch`), for
  a reader who is **not signed in** and has turned on the gear menu's link
  switch (`LinkPushSwitch`, a flag in `localStorage`). The page files a watch
  on every open poll they vote in or confirm — at the time, or the next time
  an earlier-answered poll is opened. Turning the switch off takes back every
  watch this browser filed (`disableLinkPush`), which is why the local mirror
  keeps each poll id. The creator's own poll files none, and a signed-in
  reader files none (their account is in the audience through their ballot;
  see [below](#open-polls-you-answered-while-signed-in)). One watch per group
  covers opening and results.

**A watch records nothing about who asked** — no voter key, account, name or
timestamp, since a watch made in the same second as a ballot would join the
two. It is filed against the group's first question and **deleted when the
results are announced** (or the poll closes with nothing to announce), so no
endpoint keeps a record of the polls a browser was in. The local mirror is
dropped then too. Because a watch has no address, `poll_push_targets` leaves
out the actor by dropping their own *browser* where it is bound to their
account.

**Settings are an account's.** `notification_settings` holds `email` and
`push` flags; no row means both on. An address with no account is always
emailed (the invitation is its only way to hear of the poll). Watches ignore
account settings — a watch is its own explicit ask.

**Push is one switch, about the device in the reader's hand** (`PushSwitch`).
It is on when the account's push is on *and* this device is bound. Turning it
on asks permission, binds this device and turns the account's push on (which
is also how a second device is added); turning it off turns the account's push
off everywhere. Devices stay bound, so turning it back on anywhere restores
them all. Where this device cannot take push, it is disabled with one line
saying why.

**The database decides, the function encrypts.** A push must be encrypted to
each browser's key (RFC 8291) and signed with the VAPID key (RFC 8292), which
pgcrypto cannot do. `send_push` hands the message and every target to the
Edge Function in one `pg_net` request; the function checks the shared secret,
encrypts, sends, and reports endpoints that answered 404/410 to
`forget_push_endpoints` (callable only by `service_role`). It reads no tables
and makes no decisions. It is written against WebCrypto, which also lets it be
tested under vitest.

**An endpoint is checked twice against the four push services** (Google,
Mozilla, Apple, Microsoft) — `push_subscription_valid` on the way in,
`isPushEndpoint` before the `fetch` — since it arrives from any browser and
would otherwise make the function POST anywhere.

**What a notification says** (`push_message`): the poll's title as the title,
one sentence for the moment. Its `tag` is the poll, so a second notification
replaces the first. Tapping it opens the poll, in an existing app window
without a reload where there is one (`useNotificationRoutes`).

**The tap also leaves a note**, because an iPhone launching the installed app
from a notification opens the start page regardless, and a backgrounded
window can resume without the posted message. `notificationclick` writes the
poll's hash into its own cache (`star-voting-open`, spared by the version
sweep); the app reads and deletes it on start and on returning to the
foreground. It expires after two minutes and is acted on once.

**Asking is always a press.** Nothing asks for permission on its own; the
gear menu is the one place that can. Elsewhere the app only says it can
notify (the push banner).

**iPhone and iPad need the app installed first**: Safari gives push only to a
Home Screen app opened from there. In a Safari tab `pushState` is
`needs-install`, the switch is disabled with a line saying so, and the banner
links to [`InstallGuide`](src/pages/InstallGuide.tsx) at `#/app` — public,
opened on the reader's own device type, linked from *App features*. The installed app
has its own storage, so a reader signs in again inside it, with a code (a link
opens Safari); the guide says so.

**The icon's badge counts polls with unread news**, derived rather than
stored: notifications are tagged by poll, so the count of notifications still
showing is the count of such polls. The service worker sets it whenever that
changes (`updateBadge`); opening a poll closes its notifications
([`lib/badge.ts`](src/lib/badge.ts)), on any question and again on returning
to the foreground. Shown by desktop Chromium and installed iPhone apps;
Android ignores the number.

Not done:

- **Delivery while a desktop browser is closed.** Phones have no such limit.
- **Following a rotated endpoint on a watch.** An account's device is
  re-saved on every app open (`refreshAccountPush`); a watch is dropped the
  first time its old endpoint is refused. There is no
  `pushsubscriptionchange` handler, since the worker holds no account.
- **Retries.** Best-effort, sent once.

### Open polls you answered while signed in

**An account that answers an open poll is in its audience.** A share-link
ballot or confirmation cast signed in carries the account (see [An open
ballot cast signed in follows the
account](#an-open-ballot-cast-signed-in-follows-the-account)), and
`poll_email_audience` reads those accounts through `poll_answering_accounts`,
over every question in the group. They are emailed and pushed about the poll
opening and its results exactly as an invitee is, under their own settings,
minus whoever acted — and told again if the poll is reopened and finishes a
second time. Nothing is filed by the browser.

**The switches are a menu.** `NotificationSwitches` — *Email notifications*
and *Push notifications* — is a popover off the gear in the header (`Layout`),
reading the account's settings only when opened. `/settings` holds the same
component for the email footer's link; nothing in the app links to it.
A push switch that cannot be turned on is disabled with one line and *See
how*, linking to the install guide. `Layout` closes the menu on any route
change.

**Two banners, in three places** (`Banners.tsx`): one saying where the push
switch is, one saying the site installs as an app. They appear on the poll
list, under the card after confirming the options, and under *your vote is
in* — the moments a reader is waiting on others — for every reader alike, and
not on the sign-in screen. Both are one shape (`Banner`): a sentence, *Learn
more* onto the install guide, and *Don't show again*. **The × closes it for
now; *Don't show again* for good**, in this browser.

- **The push banner** goes the moment push is on here (`usePushHere`, from
  local mirrors, live, with no request). It shows wherever the browser can be
  asked, including an iPhone Safari tab; not where the browser said no or
  has no push.
- **The install banner** shows to anybody outside the installed app.
- **Under a poll the reader removed from their list**, a third notice comes
  first and the push banner stands down: the poll will not notify them, with
  a way to put it back. It is not a `Banner` — it is a fact about this poll,
  so it has no *Learn more* or *Don't show again*. See [Removing a poll from
  your list](#removing-a-poll-from-your-list).

## Signing in

Email, with no passwords and no providers — or no account at all; see [Polls
made without an account](#polls-made-without-an-account). The reader chooses
what arrives before it is sent:

- **A link** (the default): one tap and they are signed in.
- **A code**, typed back into the window that asked.

The code exists because a link depends on the tap landing back in *this*
window, and two ordinary situations break that: an email client opening links
in its own webview, and an installed copy of the app, which has separate
storage. Neither is detectable, so the choice is offered. `verifyOtp` returns
the session on the same request, in the same window.

**The choice is remembered per browser** (`star-voting:sign-in-method` in
`src/lib/signInMethod.ts`): whether a tap comes back is a fact about this
device and email client, and it is needed before there is a session.

### How the choice reaches the mailer

Supabase renders **one** template for both, the *Magic Link* template, and
`signInWithOtp` has no argument to choose between them; a link and a code are
both minted every time. The template decides which to show, and the one part
of the request that reaches it is the redirect address (`{{ .RedirectTo }}`).
So `redirectFor` in `src/lib/AuthProvider.tsx` appends `?method=code` on the
code path, and the template branches on exactly that. The marker is
`CODE_METHOD_MARKER`; it must match the string in the dashboard template.

Go templates have `eq` and no substring test, so **every origin the app is
served from is a term of its own** in the template's `or`.

### Why the marker goes missing, and why it goes missing quietly

On the code path nothing is tapped, but the redirect address must still be
**accepted**, by
[`IsRedirectURLValid`](https://github.com/supabase/auth/blob/master/internal/utilities/request.go):
its scheme and host match the Site URL's, or it matches a pattern on the
allowed redirect list. Production matches the Site URL; **`localhost` gets in
only through the `http://localhost:5173/**` entry**.

A refused address is silent. `GetReferrer` falls back to the request's
`Referer` (the app root, without the marker) and then the Site URL, so
`{{ .RedirectTo }}` becomes the page the reader was on, the template's `eq`
fails, and everybody gets a link.

**To diagnose**, put this at the top of the Magic Link template and send
yourself a code:

```html
<p>RedirectTo: [{{ .RedirectTo }}] &mdash; Token: [{{ .Token }}]</p>
```

The Site URL or app root means the address was refused (missing list entry);
the right address with the branch not taken means the `eq` term does not
match it exactly; the literal text `{{ .RedirectTo }}` means the variable is
not being rendered.

### The Magic Link template

Paste this into **Authentication → Email Templates → Magic Link**. Add a term
to the `or` for every origin the app is served from.

```html
<!doctype html>
<html>
  <body style="margin:0; padding:0; background-color:#f2eefc; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f2eefc; padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px; width:100%; background-color:#ffffff; border-radius:16px; overflow:hidden; box-shadow:0 4px 24px rgba(126,20,255,0.12);">

            <!-- Header -->
            <tr>
              <td align="center" style="background-color:#ffffff; padding:40px 24px 24px; border-bottom:1px solid #f0edf7;">
                <img src="https://choicelab.app/logo.png" width="72" height="72" alt="ChoiceLab"
                     style="display:block; width:72px; height:72px; border-radius:16px;">
                <div style="margin-top:16px; font-size:20px; font-weight:700; color:#1a1523; letter-spacing:0.2px;">
                  ChoiceLab
                </div>
              </td>
            </tr>

            <!-- Body -->
            <tr>
              <td style="padding:36px 32px 28px;">
{{ if or (eq .RedirectTo "https://choicelab.app/?method=code") (eq .RedirectTo "http://localhost:5173/?method=code") }}
                <h1 style="margin:0 0 12px; font-size:22px; line-height:1.3; color:#1a1523; font-weight:700;">
                  Your sign-in code
                </h1>
                <p style="margin:0 0 28px; font-size:15px; line-height:1.6; color:#5b5468;">
                  Type this code into the window you asked for it in
                </p>

                <div style="margin:0 auto; padding:18px 24px; background-color:#f7f4fe; border:1px solid #ece5fd; border-radius:12px; text-align:center; font-size:34px; font-weight:700; letter-spacing:9px; color:#1a1523; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;">
                  {{ .Token }}
                </div>

                <p style="margin:28px 0 0; font-size:13px; line-height:1.6; color:#9691a3;">
                  The code expires in an hour, and works once. If you did not
                  ask to sign in, you can ignore this email.
                </p>
{{ else }}
                <h1 style="margin:0 0 12px; font-size:22px; line-height:1.3; color:#1a1523; font-weight:700;">
                  Your sign-in link
                </h1>
                <p style="margin:0 0 28px; font-size:15px; line-height:1.6; color:#5b5468;">
                  Tap the button below to sign in
                </p>

                <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;">
                  <tr>
                    <td align="center" style="border-radius:10px; background:linear-gradient(135deg,#7e14ff,#47bfff); background-color:#7e14ff;">
                      <a href="{{ .ConfirmationURL }}"
                         style="display:inline-block; padding:14px 36px; font-size:16px; font-weight:600; color:#ffffff; text-decoration:none; border-radius:10px;">
                        Sign in &rarr;
                      </a>
                    </td>
                  </tr>
                </table>

                <p style="margin:28px 0 0; font-size:13px; line-height:1.6; color:#9691a3;">
                  Button not working? Paste this link into your browser:<br>
                  <a href="{{ .ConfirmationURL }}" style="color:#7e14ff; word-break:break-all;">{{ .ConfirmationURL }}</a>
                </p>
{{ end }}
              </td>
            </tr>

            <!-- Footer -->
            <tr>
              <td style="padding:20px 32px 28px; border-top:1px solid #f0edf7;">
                <p style="margin:0; font-size:12px; line-height:1.6; color:#b3aec0; text-align:center;">
                  Sent by ChoiceLab.app
                </p>
              </td>
            </tr>

          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
```

**Check both halves after pasting it** by signing in each way once. A template
whose branch never matches is not an error anywhere: it sends a link to a
reader looking at a code screen.

### Polls made without an account

**Continue without an account** is Supabase's anonymous sign-in: a real
session and `auth.users` row with no email. The reader gets their own poll
list and can make and run open polls — close, reopen, edit options, delete —
because every creator rule is `created_by = auth.uid()`. The app marks the
differences: the home page's tile says **Sign in** (`/sign-in`, where the
sign-in screen is reachable with a session), the poll list says
the polls live in this browser, and the create form shows invite polls
disabled with the reason. `anonymous` in `useAuth` is how a component asks.

**Signing in brings the polls along.** Before the sign-in email goes out, the
browser takes out a ticket while it can still prove it is the anonymous
account (`begin_account_carry_over`); the first tab to see the account's
session redeems it (`finish_account_carry_over`), moving the polls it made,
its link ballots and confirmations (except in a poll the account had already
answered, where the account's ballot stands), and its removed polls. The
ticket is random, held only in this browser's `localStorage`, single-use and
good for a day, so a link opened in another browser cannot redeem it. See
[`lib/carryOver.ts`](src/lib/carryOver.ts).

**Losing the session is losing the polls** — there is no address to send a
way back to. The polls keep running and are purged at six months. The line on
the poll list says this up front.

#### What an anonymous session can reach

An anonymous session holds the `authenticated` role with an **empty email
claim** (`"email": ""`). At each door:

- **Tables.** `polls`, `candidates` and `ballots` are read by `created_by`,
  the invite list, or `voter_id`, so an anonymous account reaches only its own
  polls. `invited_voters` is read where `email` matches the claim, which an
  empty claim would match against a blank address, so the table carries
  `invited_voters_email_ck` and no blank address can exist however a row
  arrives. Every other table has RLS on with no policies and no grants,
  including `account_carry_overs`.
- **Functions.** Every poll function decides creator by `uid` and invitee by
  email claim, so an anonymous account is creator of its own polls and invitee
  of none. `poll_page` returns `unreadable` for an invite poll, which the
  route turns into the sign-in screen with the poll remembered.
- **Email is the one real hole.** An anonymous account costs nobody an inbox,
  so letting it make an invite poll would let anyone send mail from this
  domain. `guard_anonymous_polls`, a trigger on `polls`, refuses one by every
  path, and caps an anonymous account at twenty polls a day (a group counts
  once). That bounds one session; Supabase's rate limit bounds a script
  minting sessions (setup step 7). `guard_invitee_changes` already refuses an
  invite list on an open poll.
- **`polls.created_by_email` is null** for an anonymous creator, so the email
  audience never tries to write to an empty address.
- **Push.** Devices are chosen by address, so an anonymous account uses the
  link switch and files watches. Watches ignore account settings, so removing
  a poll from an anonymous list does not silence a watch already filed — the
  one place the removed-poll notice promises slightly more than it delivers.
- **Default privileges.** `anon` and `authenticated` hold `TRUNCATE`,
  `TRIGGER`, `REFERENCES` and `MAINTAIN` from Supabase's defaults; none is
  reachable through the Data API.

`mark_votes_after_reveal` ignores the carry-over's ballot updates, which move
a ballot without being a vote. `41_polls_without_an_account` covers what the
suite can see.

## Behaviour worth preserving

These are decisions, not accidents. Changing one changes a promise the app
makes to the people voting.

### Poll settings are frozen at creation

Each poll fixes four things at creation — who can vote, whether respondents
are shown, whether ballots are published, and where the options come from —
and `authenticated` has no `UPDATE` grant on `polls`. Everything that moves
afterwards moves through a `SECURITY DEFINER` function with its own rules
(`close_poll`, `reopen_poll`, `finalize_options`, `creator_edit_options`, …).

**`PollTags`** (`src/components/PollTags.tsx`) shows three of the four —
always both states, always in the same order and words — on the list, the
poll page and the public page. An absent tag carries no meaning anybody reads.
**Where the options came from is not shown**: it matters only while the poll
is collecting, and then the state badge (*Collecting options*) and the card
itself say so.

**Every state has its own colour**, from `src/lib/badgeColors.ts`, which holds
every badge colour in the app (badges from different files land side by side,
so choosing at the call site is how two meanings end up one colour). Add a key
there before adding a badge.

The wording is deliberately not symmetrical: respondents are **shown** or
**hidden** (hidden lists nobody), ballots are **published** or **private**.
An anonymous ballot is the combination respondents hidden + ballots
published. Change these strings in `PollTags` alone, including the count
badge's turnout wording.

### The poll's high-level details

**One poll looks like one thing wherever it is read.** The list card, the
poll page and the public page all render `PollHeading`
(`src/components/PollHeading.tsx`), in this order:

1. the **title**, with the state badge beside it;
2. the **description**, if any;
3. **who created it** — *Created by you* or their email;
4. the badges: **the count**, then invite only/open link, respondents
   shown/hidden, ballots published/private.

The description is the creator's words and belongs with the title. The three
settings run in the order `CreatePoll` asks them. The count is first because
it is the one that moves and the one a reader scans for. `compact` is the list
card's size.

**The public page omits who created the poll.** Every email address the app
displays is shown only to people already in that poll; a share link goes
anywhere, so `open_poll_view()` does not return the creator's address at all.
(An open poll's roster shows names voters typed, not addresses.) It does show
the winner in the badge.

**The state badge says** *Collecting options*, *In progress*, *Closed*, or
**the option that won** — with no *Winner:* prefix. The three finished
outcomes are distinct:

| Badge | Means |
| --- | --- |
| the option's name | STAR elected it |
| *Tied — no winner* | the election ran and settled nothing — see [Tie-breaks](#tie-breaks) |
| *Results ready* | finished, and this screen has no winner to name |

*Results ready* is a real state, never a loading state: it is what a poll of
several questions reads, and what a failed read leaves. It must never read as
*Tied*, which is why the answer travels as `winner_name` *and*
`winner_settled`. Every state the badge can draw is decided by the read that
drew the page (`list_polls`, `poll_status`, `open_poll_view` all carry the
winner columns), so nothing waits.

**A poll of several questions reads *Results ready* on every screen.** It has
one winner per question and none for the poll; each question's winner is in
the green banner over its tally. `PollStateBadge` decides this from `inGroup`
rather than trusting callers, because `list_polls` hands a group's card its
first question's `winner_name` like any other row.

**The badge and the title share a row, sixty/forty**, in a `Flex` that never
wraps: the title's basis is 60%, and only the badge carrying the poll's own
text (a winner's name) has `maw="40%"`. The app's own fixed labels keep their
width. Past that ceiling it is the title that wraps.

Row decisions:

- **No badge in the row carries approval.** Both states of each setting are
  the creator's choice, so each pair is one hue family. Approval colours
  (`done`, `outstanding`) are for progress.
- **The count stays after the poll closes.** While collecting options it
  counts confirmations instead (turnout is zero until there is a ballot).
- **Nothing in the row is about the reader** (no "vote pending").

The count is on every screen, before the reader votes too; see [Whether
respondents are shown](#whether-respondents-are-shown).

**The winner is a column, and `list_polls()` reads it**; nothing on the list
runs an election. See [The winner is kept with the
poll](#the-winner-is-kept-with-the-poll).

`winner_settled` and every other field a migration adds are required in
`rpcSchemas.ts` once landed; see the header of that file for the pattern.

**Ten polls to a page, taken in the database.** `list_polls(p_limit,
p_offset, p_removed)` returns the page and the total in one round trip. The
page is taken *before* the per-poll aggregates run (the invited, voted and
option counts, and the group-wide `bool_and`s), so only ten polls pay for
them; the total is a count over everything visible. **`polls.created_by` is
indexed** — Postgres does not index foreign keys, and without it the "mine"
half of the visibility test scanned every user's polls.

**Asking past the end lands on the last page**, clamped in the database, and
the browser derives its page count from the same total. **Ordering is
`created_at desc, id desc`**: offset paging needs a total order, and in the
suite every poll a case creates shares a `created_at`
(`20_paging_the_poll_list`). **Both arguments are required**; a default page
size would be a second copy of `PAGE_SIZE`.

### Option descriptions

An option can carry an optional description: a caveat, some detail, a link.

**Every screen has the same `+` and `−`** (`DescriptionToggle`, beside each
option's `×`), on the create form and in `CollectOptions` alike. Where a row
starts:

- **A create-form row starts closed**, since the form lays out many rows.
- **A new option in `CollectOptions` starts open** (one option at a time).
- **An option opened by its pencil starts as it is**: with its description if
  it has one.

A field the `+` just showed takes focus; one that arrives with its row does
not. The field is indented under its option with an elbow drawn to it
(`DescriptionField.module.css`), opens two rows tall and grows, and its
placeholder names its option (*Option 2 description*).

Rules:

- **Descriptions pair with options by position** (a second array to
  `create_poll`), so dropping a blank option must drop its description slot
  too. `CreatePoll` filters the pairs and `create_poll` aggregates both
  columns in one pass; neither filters one array alone.
- **Hidden means gone**: collapsing the field discards its text, and "no
  description" is `null`, so a poll never carries a description its creator
  cannot see.
- **They belong to the ballot.** Both ballots show them under the option's
  name. The score round shows one dimmed mark beside options that have one,
  opening a popover (a tooltip cannot be opened on a phone); `poll_tally`
  carries the text, on the same terms as the results. The full ranking and
  ballot grid do not.
- **URLs become links**: `OptionDescription` turns `http(s)://` and `www.`
  runs into anchors as React elements, never parsed HTML, so a description
  cannot produce a `javascript:` link.

**An option name may be 150 characters and its description 900.** The bound
exists because the suggestion path lets a whole group write to `candidates`.
`insert_option` is the one place both are applied; `src/lib/limits.ts`
carries the same numbers for the form.

Duplicating a poll copies the descriptions.

### Who can vote

|  | **Invited people** | **Anyone with the link** |
| --- | --- | --- |
| Access | Email addresses on the invite list | An unguessable link — the poll's id |
| Voter signs in | Yes | No — but may, and then their ballot follows them between devices |
| Results unlock | When everyone invited has voted, or the creator closes the poll | Only when the creator closes the poll |
| One vote each | Enforced — one ballot per account | **Not** enforced |

An open poll cannot tell its voters apart: one person can vote again from
another browser or after clearing site data. The random key in
`localStorage` (`src/lib/voterKey.ts`) stops accidental double-submits and is
not a guard. Open polls are for picking a movie; invite polls for anything
where the outcome matters. Results stay hidden until they unlock in both
modes.

### An open ballot cast signed in follows the account

A share-link ballot or confirmation cast while signed in records the account
(`ballots.account_id`, `option_confirmations.account_id`), and every
`open_poll_*` function finds a reader's ballot by it. So another device is
told the vote is in, can change it, sees the strip's ticks, and has the poll
on its list (see [Open polls you have
answered](#open-polls-you-have-answered)).

**Who "you" are on an open poll**, defined once in `open_ballot_of` and
`open_confirmation_of`:

- **Signed in:** the ballot carrying your account; failing that, the ballot
  this browser's key cast while nobody was signed in. A key another *account*
  voted with reaches nothing, so the next person on a shared browser casts
  their own ballot (without the key, since a key cannot be on two ballots in
  one question).
- **Signed out:** the ballot this browser's key cast, including one cast
  signed in.

**Nothing is claimed after the fact**: a ballot cast signed out stays
unlinked even when changed after signing in. A ballot carries an account if
and only if it was cast by one.

**A separate column rather than `voter_id`**, because `voter_id` means *an
invitee's ballot* everywhere — rosters and sheets join it to `auth.users` for
an address, `ballots_select_own` grants on it, and `statusFromOpenView`
relies on open ballots not carrying it. `account_id` is read only by the
open-poll functions and `poll_group`, never returned, and a check constraint
says a row carries one or the other.

**The strip's ticks come from the server for a signed-in reader**
(`open_poll_group` carries `voted` and `confirmed` per question; `poll_group`
counts the account's link ballots for the creator's page). Signed out, the
browser's own record stands in. `useQuestionMarks`
([`questionMarks.ts`](src/lib/questionMarks.ts)) shows a mark where either
says so, and each single-question read corrects both.

**Edit vote re-reads the ballot when signed in**, since another device may
have changed it and a changed vote announces nothing.

**Cost**: a ballot cast signed in is stored with an account on it, so it is
no longer as anonymous as one cast signed out (see [Whether ballots are
published](#whether-ballots-are-published)).

`39_an_open_ballot_follows_the_account` covers this. Cases (and
`scripts/sample-poll.sql`) that stand in several strangers call
`tests.sign_out()` first, since one signed-in account has one ballot per
question.

### A poll's link is its id

**One address, `#/<id>`, for every poll and every reader.** There is no
separate share token: the id is from the same random generator, so a token
bought no entropy, and the creator could always see the id anyway. The set of
people who can reach an open poll is whoever holds the link.

**What this gives up**, plainly:

- **A leaked link cannot be replaced.** The id is a primary key referenced
  everywhere; the only answer is to duplicate the poll and lose its votes.
- **A primary key travels where a secret should not.** Poll emails already
  link to `#/<id>` (invite polls only). Anything that logs, exports or
  reports a poll id is handling an open poll's capability — think twice
  before adding one.

**The route decides what the reader may see** (`PollPage`):

1. **A sample id** renders `PublicPoll` for anybody; it is answered from a
   file and is not a uuid, so it must never reach the database. See [The
   sample poll](#the-sample-poll).
2. **Everything else asks `poll_page`**: `account` renders `PollDetail`,
   `open` renders `PublicPoll`, `unreadable` means the poll does not exist
   *or* is an invite poll this reader is not on — deliberately the same
   answer, so ids cannot be probed. See [One read opens a
   poll](#one-read-opens-a-poll).
3. **Refused and signed out**: the sign-in screen, with the destination
   stashed by `rememberDestination`, since the reader may be on the invite
   list. Signed in and refused, `PublicPoll` says the link is dead.

**The id is spelled short in URLs**: the uuid's sixteen bytes in base64url
are 22 characters instead of 36, with the same entropy. `polls.id` stays a
`uuid`, and every id the app holds, compares or keys storage by is canonical;
`src/lib/pollId.ts` is the only place the two meet (`pollPath` on the way out,
`pollIdFromParam` on the way in). Keying storage by the short form would
orphan every browser's voter keys. **`pollIdFromParam` accepts a full uuid
too, permanently**, since poll ids are in email bodies that do not expire.
Postgres has the same encoding in `short_poll_id`, so email links match. The
sample's ids are words, passed through untouched.

### Whether respondents are shown

- **Shown** — everyone in the poll sees who has responded, from the moment
  the poll exists: invited addresses on an invite poll, names voters type on
  an open poll.
- **Hidden** — only the number of votes, to everyone including the creator.

This controls *who responded*, never *how they voted*. **One setting decides,
with no second rule about when.** Watching a roster fill reveals arrival
order; the setting opts into that, and the place arrival order is kept away
from ballots is the published sheet's hash ordering (see [Whether ballots are
published](#whether-ballots-are-published)).

**A bare count leaks nothing**, so it is on every screen, before and after
voting. What a poll keeps from its voters is how it is *going*, and the
standings stay sealed until the results unlock.

**What the roster answers changes with the stage; who may read it does not.**
While collecting options, its badges say *Confirmed* / *Pending*; while
voting, *Voted* / *Pending*; after the poll has closed, **Did not vote**, in
the closed colour (`badgeColor` in `badgeColors.ts`) — *Pending* would be a
reminder for a ballot nobody can now cast. The heading says *Voters*
throughout. `Respondents` reads `status.soliciting` for the stage.

**Turnout is stated in exactly one place on any screen**: the count badge in
the header. It counts confirmations while collecting and votes after, over
the same people. So the results do not restate turnout, no roster has a count
of its own, and **Confirm options** says what pressing it does rather than how
many have pressed it.

So the roster answers only *who*, and a poll that hides respondents renders
no roster card for anyone but its creator — for whom it is the invite list
they manage, shown without per-person status on a hidden poll (the card says
so).

### Whether ballots are published

- **Not published** (the default) — results are an aggregate tally only.
  Nobody, the creator included, can read an individual ballot.
- **Published** — once the results unlock, every ballot is readable as a grid
  (one row per voter, one column per option, column totals matching the score
  round), so anyone in the poll can check the arithmetic.

|  | **Ballots not published** | **Ballots published** |
| --- | --- | --- |
| **Respondents hidden** | Fully private | Anonymous ballots — a verifiable tally that names nobody |
| **Respondents shown** | A roster of who voted, totals only | Fully auditable — every ballot, with a name on it |

Rules:

- **Ballots unlock on exactly the same terms as the results** — completion or
  close, never earlier.
- **The creator gets no exception.** Hiding ballots is a promise to voters,
  not an access level.
- **Your own ballot is not one of them.** On an invite poll with private
  ballots, the results show the reader's own ballot (`YourBallot`), read by
  `poll_ballot_scores` — the caller's own scores only, the same function
  *Edit vote* uses. It arrives on `poll_page` as `your_scores`. It replaces
  the grid, which would already include it on a published poll. Share-link
  ballots are not shown this way.
- **The door does not change the terms.** `poll_ballots` (account) and
  `open_poll_ballots` (link) apply the same three rules: may see the poll,
  publishes ballots, results out. On an open poll both return the same sheet;
  the creator's page draws it once. The "not unlocked yet" line reads *until
  everyone has voted* or *until the poll is closed* by whether there is an
  invite list.
- **The grid downloads as CSV** (`lib/ballotCsv.ts`): the same rows, gated
  the same way, in the order the database returned them, and **no totals
  line** — the totals are the claim the file lets somebody test. It has a
  **UTF-8 BOM** (or Excel misreads non-ASCII names) and **a leading
  apostrophe on any field starting `=`, `+`, `-` or `@`**, because names and
  options are typed by anyone holding the link and would otherwise run as
  formulas. Both are tested in `ballotCsv.test.ts`.
- **Voters are told before they vote**: `PollTags` sits above both ballots,
  so whether scores are published and whether a name is attached is readable
  before anything is sent.
- **Anonymous ballots are ordered by a hash of their row id**, never by
  submission time. Since the roster shows arrival order on a poll with
  respondents shown, submission order would reattach names to ballots.

**"Anonymous" describes what the app publishes, not what the database
forgets.** An open poll that hides respondents never stores a name —
`open_poll_submit` discards one. An invite ballot always stores the voter's
account (that is how one-ballot-each is enforced), and so does a link ballot
cast signed in. No function returns either, but they are there. The strongest
guarantee is an open poll voted in signed out.

### Where the options come from

- **From the creator** (the default) — written in the create form.
- **From respondents** — the poll opens as a list. Everyone in it can add
  options, nobody can vote, until the list is opened for voting; from then the
  poll is like any other.

`solicit_options` is the frozen setting; `options_finalized_at` is the state,
set once. A poll is **collecting** when it solicits options, is not finalized
and is not closed — derived, never stored.

The promise is that **everyone who votes scores the same list**:

- **Nobody votes while the list is growing** — both submit paths refuse.
- **Nobody suggests once it is finalized.**
- **Only the creator finalizes, into a real ballot of at least two options**
  (a soliciting poll may start with none). The button is **Open poll** in
  `CreatorControls`. A group opens all its questions at once, so the floor is
  checked on every question first and the refusal names the short one; the
  button is disabled with the same reason from `poll_group`'s option counts.
- **Everyone suggests through a function, the creator included**
  (`suggest_options`, `open_poll_suggest_options`): invitees have no `INSERT`
  grant on `candidates` and `anon` has none anywhere, and one path keeps the
  rules in one place.
- **Suggestions carry no name.** Who suggested what would be a third
  disclosure question the tags do not answer.

The stage is drawn by `CollectOptions` (`src/components/CollectOptions.tsx`)
in place of the ballot, **built the way the ballot is built**: name field,
question strip, list, then the button that ends your part. The creator also
gets a pencil and an `×` on each row; opening the poll is in
`CreatorControls`.

**Opening a poll for voting is one-way.** Reopening a closed poll reopens
voting, not collecting — unless it was closed while still collecting.

### Saying you are done adding options

**Confirm options** is one press per person saying they have nothing more to
add. It means "I have had my say", not "I approve this list": a later
suggestion does not un-confirm anybody, so one late idea cannot keep a poll
collecting for ever.

- **A confirmation is per question**, like a ballot. The strip marks a
  question confirmed, and confirming moves the reader to the next list they
  owe, as a first ballot does. `poll_group` returns `confirmed` per question
  on the invite side; the open side answers it from the browser.
- **Only invitees confirm**, refused in the same words as `submit_ballot`, so
  "3 of 6" means what it says. A creator who did not invite themselves
  confirms by pressing **Open poll**; one who did confirms like anyone else
  (`poll_status.invited` says which).
- **Confirming keeps the list on screen**: the button becomes **Options
  confirmed** (green, disabled) and the list stays live with *Add option*.
- **Starting an edit takes the confirmation back.** Pressing *Add option* or
  *Add times*, or (as creator) opening or striking a row, withdraws it on the
  server (`unconfirm_options`, `open_poll_unconfirm_options`) at the press,
  and the button reverts to **Confirm options**. It shows loading until the
  re-read confirms the withdrawal; a confirm pressed meanwhile waits for it.
  The name field stays visible, disabled while confirmed, so the card does not
  jump.
- **An invite poll opens itself when the last invitee confirms**
  (`open_options_when_all_confirmed`). That function **returns rather than
  raises** on every reason not to open — it runs inside somebody else's
  confirmation — and the creator still has **Open poll**, which explains.
  **Removing an invitee runs the same check**; their confirmation leaves with
  them.
- **An open poll never opens itself**: no participant list, so no number of
  confirmations means the stage is over.
- **A share link asks for a name to confirm**, as for a ballot
  (`open_poll_confirm_options` refuses without one) — except on a poll that
  hides respondents, which stores no name and shows a count. The name is
  offered back from `lib/voterName.ts`.
- **Who has confirmed is read under the roster setting**, through the same
  column of `poll_invitees`, from the start.
- **The count is in the count badge** — `2/5 confirmed`, or `3 confirmed` on
  an open poll. The button carries no count; its line *the poll opens for
  voting as soon as everyone has confirmed* is dropped once everyone has.
- **A confirmation announces itself like a vote**; the one that opens the
  poll announces twice (roster, then list becoming a ballot).
  `16_live_update_signals` asserts both.
- **The opening is also an email**; see [What a poll writes to
  people](#what-a-poll-writes-to-people).
- **Nothing un-confirms anybody else.**

**Confirming is the save.** Everything in the card is a draft until the press
that ends it, and that press saves the draft first. Each list hands what it is
holding to the card (`DraftHold` in `CollectOptions`), and the press applies it
and then confirms; if the save is refused, nothing is confirmed and the error
appears on the field or under the list. Drafted rows look like saved rows, and
there is no count of pending changes: the list is the count.

Which press ends the card:

- ***Confirm options*** wherever this reader has a say in the stage;
- ***Done*** on the creator's correction to a list that is already a ballot
  (it saves and closes the editor, or leaves it open with the reason);
- **a *Save options* / *Save times* of the list's own** only where the card
  ends in neither — a soliciting poll's creator who did not invite themselves.

**There is no *Add* button between the field and the list**, and a typed
option stays an editable field (with a × and a rule under it) until the card
is saved — a row that looks saved must be saved. The card starts with **no**
field; **Add option**, beside the ending button, opens one and focuses it.
Empty list, no field: *Nothing suggested yet*. A blank field is never sent;
filled ones are all checked on the ending press, each problem on its own field
(two drafts with one name mark the later).

**One press, up to two requests, split by who writes** (`sendDraft` in
`CollectOptions`). Correcting a list that is already a ballot is one
`creator_edit_options`. A collecting list sends the creator's corrections and
removals through `creator_edit_options` (one transaction), then the
suggestions through the plural suggestion door everybody shares — corrections
first, so the option ceiling cannot be hit part-way through a swap.
`35_the_whole_list_in_one_press` covers both, including that the plural doors
carry descriptions.

A name already on the list is skipped by the plural doors; the card checks
duplicates as you type, so only a concurrent suggestion reaches that.
Suggestions land when their author ends the card, not as they are typed.

### The creator can correct the options until the poll closes

A poll's creator can add, remove and correct options for as long as the
poll's results are not out — not closed, and not an invite poll everybody has
answered (which reveals without closing) — regardless of where the options
came from. **The promise that everyone scores the same list is then kept by
being stated**: see [The two caveats on a result](#the-two-caveats-on-a-result).

**A late edit lands on the ballots already in.** An added option is scored 0
on every existing ballot, written down by `fill_scores_for_new_option`: *one
score per option per ballot* is an invariant the schema reads rather than
checks (`replace_scores` would refuse to revise a short ballot, the sheet and
CSV assume a full grid). A removed option's scores cascade away.

**`guard_options_frozen`** refuses any change to `candidates` on a poll with
ballots, from any path, *except* the creator's own correction, which declares
itself with the transaction-local `app.editing_options` naming the poll. So a
bare delete through the `candidates_delete` policy, or a late suggestion, is
still refused.

- **`creator_add_option()`** is the creator's typed-name door (no `INSERT`
  grant exists). Refused on a time poll.
- **`insert_option()`** is the one place an option's field rules are applied
  (name, description, duplicates, the ceiling), granted to nobody.
- **The two-option floor applies to the list an edit leaves behind.**
  `creator_edit_options()` takes removals, corrections and additions and
  applies them in one transaction — removals, then corrections (one `UPDATE`,
  duplicate rule checked afterwards, so two options can swap names), then
  additions — with the floor checked at the end. A refused edit leaves the
  poll as it was. A bare `delete` is still judged a row at a time, since that
  grant is direct. A collecting list may be pruned to nothing; the floor is
  applied when it opens.
- **A correction is an update in place** (`p_correct`): the option keeps its
  id, position and every score already given. Treating it as remove + add
  would zero that option on every ballot. Time polls take no corrections.

**The card never enforces the floor itself**, and the × is never disabled;
*Done* sends the draft, and a list below two comes back with *A poll needs at
least two options* and the draft intact.

**Every row is a draft until *Done*.** Struck rows are struck through whole
(name and description) with **Keep** beside them; removal waits like
everything else. Keep restores whatever the reader last meant, including a
correction made before striking; corrections are dropped only by the save. A
pencil turns a row into its two fields in place, with no per-row Save or
Cancel; several can be open at once; a row opened and left unchanged is not
sent. The duplicate check counts struck rows: a name the list visibly holds is
taken.

**Edit options** in `CreatorControls` swaps the ballot for the editor. With
votes already in, a modal first says how many votes are on the list, that the
results will carry a note, and what a late edit does to those ballots (added
option scored 0, removed option's scores gone), with **Duplicate** offered
beside it. The same sentence sits under the editor beside **Done**. Closing the
poll takes the button away.

**A voter with the old list on screen** is refused on submit, not filed: both
submit paths demand a score for every option and reject an id not on the
poll.

### Changing your vote until the results are out

**Change my vote** is on the card you come back to after voting, on both
kinds of poll. **The window is "the results are not out", not "the poll is
open"**: an invite poll reveals itself when its last invitee votes, without
closing, and re-scoring against a visible result is the one thing a revision
must never allow.

That rule is `poll_results_revealed(polls)`, written once and used by
`revise_ballot`, `open_poll_revise`, `poll_status`, `open_poll_view` and
`assert_results_readable` — so the results opening and revisions closing are
one event. `guard_invitee_changes` draws its line in the same place.
(`open_results_poll_id` is deliberately separate: its two conditions carry
their own messages, and the compound half is unreachable on an open poll.)

**On an invite poll the window shuts for everyone the instant the last
invitee votes**, so the last voter never gets one. The wait card says "until
everyone invited has voted" for that reason.

**A vote is replaced, never withdrawn.** Every revision updates the existing
scores; the ballot row never moves, so turnout, completion and the roster are
untouched and a reveal cannot be undone. There is no "take my vote back".

**A revision announces nothing** unless an open poll's voter name changed:
nothing a watcher can see before the reveal depends on scores. Two
conditions are enforced:

- **A revision changes scores and, on an open poll, the voter's name — and
  nothing else.** The name box is disabled once the vote is in and re-enabled
  by *Edit vote*, starting from `your_name`; `open_poll_revise` calls
  `broadcast_poll_change` only when the name moved.
- **It updates in place, never delete-and-insert**, which would fire two
  spurious signals and change the ballot id.

`replace_scores()` is the scoring half shared by both paths, and also checks
that the payload names each option **once** (otherwise a ballot could keep an
old score on another option and look complete).

**Reading your own ballot back**: an open poll's arrives inside
`open_poll_view` as `your_scores` (by `voter_key`, or the account), so signed
out *Edit vote* costs no request; signed in it re-reads. An invite poll's
comes from `poll_ballot_scores()` on the press (`authenticated` cannot read
`scores` directly).

**The open-poll cost**: `voter_key` now hands a ballot back, so on a shared
browser the next signed-out person sees the previous one's scores. The key is
per poll, in `localStorage`, and never leaves the browser; a signed-in next
person gets nothing from another account's key.

### Reopening a closed poll

`reopen_poll()` clears `closed_at` on **every question in the group**, keeps
every ballot, and is the creator's alone. Everything a reopened poll must
forget is already handled by triggers that reconcile rather than assume:

- `settle_winner` clears the winner of any question that no longer has a
  result, and elects again on the next finish;
- `notify_results_ready` clears `results_announced_at`, so a second finish is
  announced;
- `broadcast_poll_updated` makes every page re-read.

**Full turnout cannot be undone**: `poll_gate_open` reveals an invite poll
everyone has answered, closed or not, so reopening one changes nothing
visible. **Reopen poll** is offered only when `is_closed && !is_complete`.

There is no reset that deletes votes; **Duplicate** is the honest way to start
again.

### The two caveats on a result

A correctable option list and a reopenable poll can both move a tally
somebody has read. Neither is refused; **the poll records it and the results
say so**:

| column | means |
| --- | --- |
| `options_edited_after_votes` | the option list was changed (in fact, not just resent) while the poll held ballots |
| `votes_after_reveal` | a vote was cast or changed after this question had shown its tally |
| `reopened_after_reveal` | internal: this question was reopened having shown its tally, which makes the next vote a late one |

The third exists because `poll_results_revealed` is computed, so after a
reopen it cannot say "was it ever out"; `reopen_poll` records the answer
before lifting the close.

- **Flags, not a log.** Which option changed or whose vote moved is not
  something the app can truthfully say: ballots are secret and revisions
  overwrite in place.
- **`votes_after_reveal` is raised by `ballots_mark_late_votes`**, a row
  trigger on `ballots`, which catches every submit and revise path.
  `options_edited_after_votes` is set by the creator's option functions, only
  when something actually changed.
- **Carried inside `poll_tally`**, so they reach exactly the readers of the
  result. `Results` draws each as a yellow card under the winner (yellow, not
  the tie's orange).
- **Never cleared.**

### A ballot started is kept until it goes in

A ballot's scores are written to `localStorage`
(`star-voting:ballot-drafts`, [`lib/ballotDraft.ts`](src/lib/ballotDraft.ts))
as they are given, and both ballots reopen with them on remount — after a
refresh, a discarded tab, or a step to another question and back.

- **Only before the ballot goes in.** The server always wins: *Edit vote*
  opens with the server's scores (`initial`) and touches no draft. A draft is
  deleted when its ballot is accepted, kept when refused.
- **Ten polls, newest kept**, a group counting once.
- **Filed against whoever wrote it** (the account, or nobody) and read back
  only by the same.
- **Narrowed to the ballot as it now is**: removed options dropped, new ones
  at 0, calendar cells outside the poll dropped. That is why a correction's
  remount (`refreshKey`) keeps the draft.
- **The calendar keeps its painting, not its scores**, which would blur.
- **The sample keeps drafts in memory**, and `PollPage` forgets them on the
  way out.

The voter's name (`star-voting:voter-name`) is saved as it is typed; an
emptied box forgets it. A draft is never trusted by the server.

### The order the options come in

`BallotCard` shuffles its options, the same way for one browser every time
(`src/lib/ballotOrder.ts`). Position on a list is worth points, so a fixed
order hands the first-typed option an advantage; per-browser shuffling stops
it always landing on the same option, and stability keeps the ballot usable
on reload or revision.

One seed in `localStorage` is hashed with each option's id, so a new option
slots in without reordering the rest and each poll gets an unrelated order.
Storage that refuses falls back to a per-tab seed. The hash is FNV-1a **with
murmur3's avalanche finisher**, which is load-bearing: plain FNV over
same-seed inputs gives measurably uneven first places (24% vs 17% on five
options); with it, every option is within 19.8–20.2%.

Display only — ballots are sent and read by option id. Nothing else is
shuffled: results are by score, the published sheet by hash, the creator's
editor in typed order, a calendar chronologically.

### Scoring an option

The stars are `src/components/StarRating.tsx`, not Mantine's `Rating`.
Mantine sets the score on `touchstart` from the finger's x coordinate, so a
finger landing on a row to **scroll** scores it, and its synthesised click can
apply the tap twice (clearing it). Ours is a button per score on one event
path (`click`): a swipe scrolls and changes nothing. The buttons are padded
past the 20px star, and the group is a radio group (one tab stop, arrow keys).

0 is a real score; pressing the star already picked returns to it, which the
line above the options says.

### What a form checks before it sends

Errors sit on the field they belong to, every rule is checked in one pass, and
they appear **on the first submit and clear as each field is fixed**.
`CreatePoll` computes the full error set every render and shows it once
`showErrors` is set.

`src/lib/limits.ts` holds every length, and the option name, description and
count limits are the database's own (`insert_option`). The create form also
refuses two options differing only in case, marking the later one. Title and
poll description lengths are the form's alone.

None of this is relied on: **the database decides**, and anything it refuses
for another reason appears as the error under the form.

### Creator controls

The creator's **Manage poll** block holds everything done to the *poll*:

- **Open poll** — on a collecting poll only; finalizes the list. One-way.
  Disabled, with the reason in a tooltip, until there are two options.
- **Edit options** — while the results are not out (see [The creator can
  correct the options until the poll
  closes](#the-creator-can-correct-the-options-until-the-poll-closes)). The
  way out is **Done** under the list itself, so this button is hidden while
  the editor is open.
- **Close voting** — reveals results from the votes so far.
- **Reopen poll** — on a closed poll that is not at full turnout; see
  [Reopening a closed poll](#reopening-a-closed-poll).
- **Send reminder** — on an invite poll taking votes; once per poll, then
  disabled as *Reminder sent*. See [Reminding the voters a poll is waiting
  on](#reminding-the-voters-a-poll-is-waiting-on).
- **Duplicate** — opens the create form prefilled (options, invitees,
  settings). Nothing is created until submit.
- **Delete poll** — removes the poll and every vote, permanently.

Open, close, reopen, remind and delete confirm in a modal, and **the modal is
where the consequences are spelled out** — the buttons carry no explanatory
text.

**The share link** (`ShareLink.tsx`) sits in the same block with **Share**
and **QR code**, since the link must go out before anyone votes. Open polls
also offer it on the thank-you card.

**Share opens the device's share sheet** ([`lib/share.ts`](src/lib/share.ts))
with one string: a sentence for the poll's stage (*Vote in "Movie night"*,
*Help choose the options for …*, *See the results of …*), a blank line, and
the link. The link goes in the text rather than as `url`, because apps join
the two inconsistently. Without a share sheet the button says **Copy** and
copies the bare link. The intro's share goes through the same helper.

**The label and caption span the whole row**, not just the text box: an
`Input.Wrapper` holds the box and buttons, and the label reaches the box
through `htmlFor` (hence a generated id). The caption is about the link, which
all three controls hand out. **The box has a 14rem floor**, and the buttons
wrap below it rather than squeeze it.

### A poll can ask more than one question

A multi-question poll is **several ordinary polls that know they belong
together**: `group_id` names the set, `question_position` the place in it,
`question_title` what that question asks. Title, description, mode and
settings are the same on every row. The three columns move together or not at
all (`polls_question_ck`) and are frozen at creation.

**Nothing about the election changed**: `poll_tally`, `star_round` and
`poll_ranking` take a poll id, and a question is a poll. That is why this is
a column on `polls` rather than a `questions` table.

Three things belong to the set:

1. **One invitation.** Every question carries the whole invite list (RLS on
   options and ballots reads it), and `trg_send_invite_email` fires for the
   first question only, via a `WHEN` clause calling `poll_is_first_question`.
   One email per person, linking to question 1.
2. **One reveal.** `poll_results_revealed()` asks the *gate* of every question
   in the group, so no question's result is readable while another is taking
   votes. **"Has anyone answered" stays per question**: a poll closed before
   anyone reached question 5 shows question 1's result and says question 5
   took no votes.
3. **One lifecycle.** `close_poll`, `reopen_poll`, `finalize_options` and
   Delete act on the whole group.

**Ballots, voter keys and voter names stay per question.** A voter gets one
ballot and one `voter_key` per question (`voterKeyFor()` is per poll), so one
browser's ballots cannot be joined on the server. The name is carried in the
browser (`src/lib/voterName.ts`), never linked on the server.
`open_poll_group` therefore returns no answered flags to a signed-out reader;
`poll_group` does (an invite ballot carries an account), and so does
`open_poll_group` for a signed-in reader. The cost: nobody can tell whether
the people who answered question 2 are the ones who answered question 1.

**For a signed-out reader the ticks come from the browser**
(`src/lib/questionMarks.ts`): written when a ballot or confirmation goes in,
never sent anywhere, and load-bearing for nothing — the server decides every
vote and read from the key. Two marks, stored separately because they are
true at different stages: answered (a ballot) and confirmed (while
collecting). A read that comes back *not voted* or *not confirmed* erases the
mark. Both are keyed by poll id.

**Collecting options is one stage for the whole poll**: each question gathers
its own list, but `finalize_options` opens them all at once (see [Where the
options come from](#where-the-options-come-from)).

**Writing one.** `CreatePoll` holds a list of `QuestionDraft`s whether or not
the poll asks more than one, so every option-list rule is written once. With
*Multiple questions* on, the questions sit behind tabs — the same shape
`QuestionStrip` gives voters.

- **`+` is the last tab.** It is never selected: pressing it makes a question
  and opens that. One `onChange` tells them apart by a sentinel value.
- **Removing a question is a named button at the foot of that question**,
  opposite *Add option* — not an `×` near the title field, where it would read
  as "clear this field" and sit beside the option rows' own `×`. Removing one
  of two questions leaves a single-question poll keeping the other; turning
  *Multiple questions* off keeps question 1.
- **Enter in an option field moves to the next option's name**, creating one
  at the end; Shift+Enter breaks a line in a description.
- **Every question is validated on every submit**; a tab with a problem is
  marked, and a failed submit opens the first.
- **Questions are keyed, not indexed**, so removing one does not shift what a
  tab shows. Keys never leave the form; `create_poll_group` takes questions in
  order.

**On screen.** The poll list shows position 1 only (`list_polls`), and the
count badge reads *N questions* on the list, the poll page and the public
page alike — turnouts differ per question, and one poll should not read two
ways. `PollDetail` counts `poll_group`, `PublicPoll` counts `open_poll_group`,
and a poll with no group counts as one. On the public page the group arrives
after the poll, so until then there is **no badge** rather than a turnout
that changes. The state badge reads *Results ready* (see [The poll's
high-level details](#the-polls-high-level-details)). `QuestionStrip` renders
nothing below two questions.

**Answering a question opens the next one owed**, automatically, on three
conditions:

- **A first ballot only.** `OpenPollPanel` takes `onFirstVote` separately from
  `onChanged`; a revision never advances.
- **To a question still outstanding** (`nextUnansweredKey` in
  `src/lib/nextQuestion.ts`), searching forward and then wrapping round, so a
  voter who started at question 3 is taken back to question 1.
- **Only while something is owed**; otherwise the page re-reads into *your
  vote is in*.

The list it chooses from is the list the strip is drawn from, and the question
just answered is excluded by key (no read has confirmed it yet). Advancing
replaces the re-read. **A read that lands late is dropped** (`onScreen`): the
ballot's own broadcast can start a read of the question just left, which must
not be drawn under the next one's address.

**The results coming out go back to question 1**
([`lib/resultsLanding.ts`](src/lib/resultsLanding.ts)), since the revealing
ballot is usually on the last question. Only the moment of the reveal moves
anybody.

**Every stage a reader can be left in carries the strip**, on both readings,
including *your vote is in* and the end of the poll (the tally, and the notice
a question with no ballots puts up). There the strip sits **above** the block
rather than inside a card, so a tally that fails to load cannot take the
navigation with it. The strip is built once per page and passed to every
branch. **On a poll that has stopped taking votes it marks nothing**: both
pages pass `answered` as `undefined`, which it draws in one neutral colour.

**A crossing between two questions replaces the question, not the poll.**
Moving between questions changes the route's parameter, not the route, so the
page stays mounted. The poll's half — heading, terms, strip, name box — stays
on screen; **the question's half** — what it asks and the ballot — is replaced,
showing `QuestionSkeleton` until the read for *this* question lands. (Keeping
everything would show the previous question's ballot under the new address;
keying the route on the parameter would blink the strip.)

The strip and the name box are drawn *inside* the card the question's half
replaces, so both are handed to the stand-in and drawn there for real:

- **The strip** is the `questionStrip` node the ballot takes (built once
  beside `strip` in `PublicPoll`, as in `PollDetail`). Its links stay live.
  It is placed as the page will place it: inside the card wherever there is
  one card, above the block on a finished question (the stand-in is told
  `finished`). Under it, the stand-in draws as much of the ending as is
  certain (`tallied`): **results out with no `closed_at` means every invitee
  answered every question**, so every question has a tally and the whole
  tally shape is drawn. Otherwise it draws the one card both endings share.
  An open poll passes no `tallied`. Invite polls know each question's
  `option_count` from the strip; the share-link reading uses the default.
- **The name box** is `VoterNameField`, with state held by the *page*
  (`useVoterName`), so it survives the crossing with what was typed. It is on
  every question still taking answers; on an answered one it is disabled and
  shows the ballot's name until *Edit vote*.

Both sit outside the stand-in's `Loading` wrapper, which hides its contents
from screen readers.

Each page draws the line with one value: `PublicPoll` holds `{ pollId, view }`
and falls back to the last read of a *sibling* question (per the strip's own
list); `PollDetail` keeps `loadedFor` and gates on `showing`. With no group
held for the address, both show the whole-page skeleton.

### Telling people the results are ready

`notify_results_ready` and the four triggers calling it (a ballot arriving, a
ballot leaving, an invitee leaving, `closed_at` moving) email and push when a
poll's results unlock. It is idempotent: it re-derives whether the poll has a
result and reconciles the notice with that, so no trigger needs to know what
the others did.

- **Once per poll**, filed against the group's first question.
- **The claim is a column**, `polls.results_announced_at`, set only where
  null; a second concurrent ballot waits on the row lock and finds it set.
  `broadcast_poll_updated` ignores changes to it.
- **Reopening takes the notice back**, so a second finish is announced.
- **`poll_results_ready()` is not `poll_results_revealed()`.** The email is
  about the poll, so the ballot test is asked of the group: at least one ballot
  somewhere, and every question's gate open.
- **Every invitee is told**, voted or not, deduplicated and lowercased.
- **The creator is told only if the poll finished on its own** (`closed_at`
  null). An open poll only ends by being closed, so it tells only the
  accounts that answered it.
- **Nor is whoever's ballot ended it** — read off the token, since the
  notifier runs in that ballot's transaction.
- **One request per address**, so invitees never see each other's addresses.
- **The email does not name the winner**: a group has several, and an email
  cannot be unread by somebody who wanted to see the tally first.

Nothing is needed for an invitee *arriving*: `guard_invitee_changes` refuses
to widen the list once results are out. The claim comes before the send, so a
missing mailer leaves a poll marked announced with nothing sent; releasing the
claim on failure would turn a Resend outage into duplicates.
`21_results_ready_notices` covers everything but the send.

### Writers take turns

Every function that reads a poll's state and then writes on the strength of
it calls `lock_poll` first — on the group's first question, so a group is one
queue — holding it to commit. `43_one_writer_at_a_time` fails if one is added
without it.

Under READ COMMITTED, two concurrent transactions each see only what had
committed when their statement began, so without the lock: the last two
invitees voting together each saw one vote outstanding and neither settled
the winner; the last two confirmations never opened the poll; a vote beside
**Close** went in after the winner was settled; a vote beside an option being
added missed its zero score. All were reproduced with two sessions.

**The lock** is `FOR NO KEY UPDATE`, **taken before the function reads
anything** (a lock after a read locks a stale picture). The second writer
waits and then sees the first's work, carrying on correctly or being refused
in its usual words. `NO KEY` avoids blocking foreign-key checks on inserted
child rows; it does conflict with the `UPDATE`s of `close_poll` and
`reopen_poll`. **Reads take nothing and wait for nothing.**

The tables the browser writes directly (invitees, option deletes) are queued
by their guard triggers, and the three reconcilers (`settle_winner`,
`notify_results_ready`, `open_options_when_all_confirmed`) lock as well.

### What a poll writes to people

- **The invitation says which stage the poll is at**: `poll_invite_kind`
  answers `options` while collecting and `vote` once there is a ballot, read
  when the address is added.
- **Nobody is told what they just did.** The creator gets no invitation (even
  if they invited themselves), no "voting is open" for their own Open poll,
  and no results email for their own Close. The invitee whose confirmation
  opened the poll, or whose ballot finished it, is left out too.
- **Nobody is told about a poll they removed from their list** (see [Removing
  a poll from your list](#removing-a-poll-from-your-list)), except by being
  invited again.
- **The rule is one function**: `poll_email_audience(poll, include_creator,
  actor)` — every invitee plus the creator, deduplicated and lowercased, minus
  the creator when the flag says they already know, minus the actor's address
  wherever it appears, minus removers, plus accounts that answered an open
  poll signed in. `poll_results_audience` passes `closed_at is null`;
  `notify_poll_opened` takes the flag from which opener called it.
- **The actor is read off the token** (`lower(auth.jwt() ->> 'email')`), since
  the notifiers run in the transaction that caused them; null drops nobody.
  The flag stays anyway, to distinguish a deliberate act from a threshold
  being crossed. The audience takes the actor as a parameter, so tests can ask
  it directly.
- **Removing an invitee is the creator acting**, and can open or finish a
  poll; the same rule covers it.
- **Opening is announced once** by construction: `options_finalized_at` is
  written once. `open_options_when_all_confirmed` announces only when its
  update actually opened something.
- **One letterhead, one mailer, one button.** `poll_email_html` is the card,
  `send_poll_email` the only Resend caller, and every email's button says
  **Open poll**. Its footer links to `#/settings`. Sent per address.
- **Subjects are short, plain and fixed**, without the poll's title
  (*You've been added to a new poll*, *Voting is now open for your poll*,
  *Results are available for your poll*); the first line of the body names
  the poll (*Vote now for X*, …). The bodies say what happened and stop.
- **A group is one letter per person at every stage**, addressed about
  question 1.
- **An open poll writes only to the accounts that answered it signed in**,
  with no special case: it has no invite list, never opens itself, and only
  ends by being closed.

`23_who_the_emails_go_to` covers the decisions; no send is testable.

### Reminding the voters a poll is waiting on

**Send reminder** emails and pushes every invitee still owed a vote, on the
standard letterhead and under their own settings. `42_a_reminder_to_vote`
covers all but the send.

- **Once per poll, ever**: `polls.reminder_sent_at`, set only where null, on
  the group's first question, never cleared (not even by reopening). A second
  press is refused. `broadcast_poll_updated` ignores it.
- **Only an invite poll taking votes**, and not one waiting on nobody but its
  creator.
- **Owed a vote on any question** (`poll_outstanding_invitees`).
- **`poll_reminder_audience` is `poll_email_audience` narrowed to the
  outstanding**, so removers and the creator are left out by the usual rules.
- **Whether it can be sent ignores removals**, and it does not say how many it
  reached, so a creator cannot learn who removed the poll.
- **The page learns it from `poll_status.reminded_at`**; the press sets the
  button to *Reminder sent* at once and sends no live signal.

### Removing a poll from your list

**On screen this is archiving**; the database and code say *removed*
(`removed_polls`, `remove_polls`). Removing is the reader's own housekeeping:
the poll leaves their list and stops notifying them, and nothing else changes.
It is still readable, answerable and counted, and nobody else — the creator
included — can find out. On the browser's side it is
[`src/lib/removedPolls.ts`](src/lib/removedPolls.ts).

Each card has an archive box at its bottom right (tooltip: *Archive: move it
off your list and stop notifications about it*). **Archived**, at the top
beside *New poll*, opens the list's address
with `?archived` — the archived polls, each with **Restore** — and is drawn
only while something is archived. It carries no count (`removed_count` decides
only whether it is drawn; it rides on every row like `total_count`, and an
empty main list asks `removed_poll_count()` instead). The archived view has no
*New poll*; its way back is `BackToList`. The list is keyed on the query.

**The pager is a pill floating at the foot of the screen** (`.pager` in
`PollList.module.css`, `position: sticky`), in the opposite colour scheme to
the page. Its colours are stated in that stylesheet, not by setting
`data-mantine-color-scheme` on it, because Mantine's control styles match any
ancestor carrying that attribute. **The page size is fixed at ten**, since
cards are not one height.

**Answering a removed poll does not restore it**, and the card the reader
lands on says so: `removed` from `poll_page` (or `poll_is_removed`) puts a
notice above the banners with **Add back to your list**, and the push banner
stands down.

**It is stored in the database** so it pages correctly and follows the
account across devices. `removed_polls` has RLS on, no policies and no grants;
only `list_polls`, the functions that write and count it, `poll_is_removed`
(the caller's own rows) and `poll_email_audience` read it.

**It stops the notifications**: `poll_email_audience` leaves out every
account that has removed the poll, in any role. Restoring puts it back.
Invitations do not ask (a re-invitation is news).

**It is not leaving**: an invitee stays on the list and can vote; a creator
still manages the poll.

**The page closes up**: `list_polls` splits removed from not *before* taking
the total and the page, so a page is always full and the pager counts what it
can show. `p_removed` defaults to false.

**A group is removed whole**: removal is filed against the list's row for the
group (`poll_list_row`) whichever question was passed.

**Both directions announce themselves on the reader's `user:<id>`**; the
poll's own topic hears nothing.

Which list is open is not remembered. **The card is not an anchor** (a
control inside a link is invalid HTML): the heading is the link and its
`::after` covers the card.

### Open polls you have answered

**An open poll your account has voted in or confirmed is on your list**,
among the rest by date, on every device. `list_polls` reads the
`account_id` on ballots and confirmations in any question of the group; the
row is the group's first question. A poll merely opened, or answered signed
out, is not listed — the database records no "opened", and the polls worth
coming back to are the ones you took part in.

**The list tells nobody more than the link does.** A row on the list only
because it was answered carries null `created_by` and `created_by_email`, so
the card has no *Created by* line. `37_answered_open_polls_on_the_list` holds
this, and that a ballot cast signed out lists nothing.

**The cards are live on the reader's own topic.** `broadcast_poll_change`
and `broadcast_poll_gone` tell the `user:<id>` of every account that answered
any question of the poll (`poll_answering_accounts`), beside its creator and
invitees. `broadcast_polls_emptied` tells accounts whose own rows are leaving
(a confirmation taken back, which takes the poll off their list). So every
page watches one topic per question, and `useLiveStream` takes one topic; a
poll page holds up to three `useLiveStream`s through its `QuestionWatch`es.

Cost: one message per answering account's list per change, as with invitees.

### Polls are deleted after six months

Every poll is deleted six months after it was **created**. The schema half is
in the baseline and the scheduling half in
[`after-squash.sql`](supabase/after-squash.sql):

- `poll_retention_window()` is the only place the period is written;
  `poll_expires_at(polls)` is when one poll goes.
- **The clock runs from `created_at`, and nothing moves it.** Measuring from
  last activity would let one stray vote on an open poll keep a forgotten
  poll alive forever. A poll that must outlive six months gets
  **Duplicate**.
- `purge_old_polls()` deletes expired `polls` rows and relies on
  `ON DELETE CASCADE`, the same definition **Delete poll** uses. It sets
  `app.purging_polls`, so it announces nothing.
- **pg_cron runs it nightly** as `purge-old-polls`. Both
  `create extension` and `cron.schedule` sit in `DO` blocks that degrade to a
  notice where pg_cron is missing; `test/sql/shim.sql` stands in a `cron`
  schema so `12_poll_retention` can assert the job.

If the job is missing on the live project, this is the whole fix:

```sql
create extension if not exists pg_cron;
select cron.schedule('purge-old-polls', '17 4 * * *', 'select public.purge_old_polls()');
```

`select * from cron.job_run_details order by start_time desc limit 10;` shows
whether it runs, and `select purge_old_polls();` runs it by hand.

The date reaches the app as `expires_at` on `poll_status()`. **`RetentionNote`**
(`src/components/RetentionNote.tsx`) shows it at the foot of the poll page,
**to the creator only** — the only act available (Duplicate) is theirs. It is
quiet until the last month, then an orange warning naming Duplicate.
`open_poll_view` carries no expiry.

### The QR code

`ShareQr` (`src/components/ShareQr.tsx`) encodes the share link, for a room of
phones. It grants exactly what the link grants — on an open poll, putting it on
a projector puts the poll in front of the room, and the modal says so.
Generated in the browser with `uqr` via `src/lib/qr.ts`, which fixes four
things:

- **Error correction M**, not the default L, so a printed, photographed code
  still scans.
- **A four-module quiet zone** (uqr's default of one is below spec).
- **Black on white in both schemes**, on its own white plate.
- **The PNG is drawn module by module** at a whole number of pixels each, so
  no boundary is anti-aliased to grey.

It is behind a button; a scannable code is too big to sit in the block.

### Results and the full ranking

The results show the winner, then the runoff between the two finalists, then
every option's score-round total, each round with its tie-break if it needed
one. On a poll that publishes its ballots, the ballot grid follows (with
column totals); on an invite poll that does not, the reader's own ballot.
The participation card is last and is where turnout is stated; the results
say only that voting was closed early, when it was.

**See the full ranking** (three or more options) opens the whole field in
placed order. STAR names only a winner, so the rest comes from running it
again on what is left: the winner steps out, the two highest remaining scorers
go to a runoff for the next place, and so on. Score totals are absolute, so
the score order is fixed and each round is the next runoff down it.

**It is a separate request, made when the button is pressed**
(`get_poll_ranking` / `open_poll_ranking`, via `poll_ranking`), because the
ladder is the most expensive thing the app asks the database for and most
readers never open it. `poll_tally` runs the head round and stops. Opening the
modal re-runs the head round (first place is part of the ranking), and the
modal has a loading state; whether the button appears is decided from the
option count the tally already carries.

**The gate is one function, not four**: both ranking functions call the same
`assert_results_readable` / `open_results_poll_id` as the results functions,
since the ranking discloses more than the tally. `17_ranking_is_gated` holds
each refusal.

The modal states two consequences:

- **The headline runoff's loser is often not second**: it still has to beat
  the third-highest scorer.
- **Most pairs never meet.** n options take n−1 runoffs out of n(n−1)/2
  pairings. Where two met, the loser is placed lower; elsewhere an option can
  be preferred to one placed above it. Only first place is STAR's own output.

#### The page stops at ten rows, or twenty

**The scoring round shows ten rows** ([`SCORING_ROWS_MAX`](src/lib/resultsRows.ts)),
since a time poll can have hundreds of options and every reader scrolls past
this list to reach the rest. It cannot lose a finalist: `poll_tally` orders by
total and lifts a tie-break winner above those it tied with, so the finalists
are the first two rows. **The tie-break's lists stop at twenty**
([`RESULTS_ROWS_MAX`](src/lib/resultsRows.ts)), as does the sentence naming
who tied (`NameList`'s `max`, "and 28 others"). `capRows` cuts and `count`
words the remainder; `TallyShape` draws the same ten. The full ranking is
always available on any poll long enough to be cut, and the line under a cut
list says so.

**The cut is in the browser, not in `poll_tally`**: `FullRanking` reads every
option's name out of the tally, and the option count decides whether to offer
the button. The cut also bounds the bars' 40ms stagger
(`Results.module.css`).

#### The runoff comes first

The runoff is drawn straight under the winner and the scoring round below it
— the opposite of the order STAR runs them — because the runoff elects the
winner, and a reader seeing a score-round leader who lost needs the
explanation next to the name. `TallyShape` follows the same order.

#### Each round carries its own tie-break

Two rounds, **Runoff** and **Scoring**, each a heading over one card
([`RoundCard`](src/components/RoundCard.tsx)). A round's tie-break is behind a
**Show tie-break** button at the right of its heading, which slides a panel
over the round's card. The scoring round's panel holds the ties broken to fill
the runoff; the runoff's holds how a level runoff was settled (total score,
then five-star votes, each marked *Decisive* or *Still tied*). **The card
never changes height**: a longer tie-break scrolls inside it. The hidden side
is `inert`.

**The runoff is half a pie** (`RunoffChart`, on `@mantine/charts`): one
finalist's voters from the left, the other's from the right, names under each
end, so the winner is visible before any number. **At most two slices**: voters
who scored both finalists the same are counted in a line under it, except in a
runoff nobody took a side in, drawn as one grey slice. It is a full pie centred
on the bottom edge of a half-height box. It sweeps in except under reduced
motion (it animates from JavaScript, so it checks `useReducedMotion`). Its
stylesheet is imported in `Results.tsx`, so ballots never fetch it.

### Tie-breaks

Documented for readers on [`/star`](src/pages/Learn.tsx) and implemented in
the migrations. A score-round tie between **two** options goes to the one more
voters preferred head-to-head, then the one with more five-star ballots, then
random (by id); a tie of **three or more** goes straight to five-star counts,
then random. These are the STAR Voting project's published rules, as
[BetterVoting](https://docs.bettervoting.com/help/ties.html) runs them. A
runoff tie goes to the higher total score, then to five-star counts; if still
level, there is no winner and the app reports the tie. **Change a rule in the
SQL, *What is STAR?* and `test/sql/cases/` together.**

Head-to-head is not tried on ties of three or more: a round-robin is quadratic
in the tied group (time polls tie dozens of windows) and hard for readers to
follow.

**A head-to-head step is reported as the comparison it is.** `star_round`
sends the pair in `steps[].matchups` (always one: both options, voters
preferring each, voters scoring them equally), and `Results.tsx` words it as
the runoff does — "3 voters preferred each, 2 scored them equally". It is an
array because recorded payloads, including the sample, use that shape.

**Rules are named in order, not numbered**: *First rule: Head-to-head
preference*, *Second rule: Five-star votes*.

The counts ride in the payload. `TiebreakStep` is a union on `rule`, so a
head-to-head step cannot be read without its matchup.

### Settling a tie with a coin

When the card says **No winner**, every rule is spent. It carries **Flip a
coin**, whose modal names one finalist.

**It is not part of the election**: `winner_id` stays null, the poll list
still shows a tie, the modal says so, and nothing is written.

**Every reader gets the same side.** A per-browser draw would give different
readers different answers. `src/lib/coinFlip.ts` hashes the poll id and the
two finalists' ids (sorted) and reads one bit — stable on every device, with no
write, no race and no new grant, and the sample poll works too. It cannot be
rigged: the ids are uuids Postgres minted, and the option list is fixed long
before a tie is foreseeable. The hash is FNV-1a with murmur3's avalanche, which
is load-bearing (raw FNV's lowest bit is the parity of the input bytes).
`coinFlip.test.ts` asserts stability and fairness.

**The coin turns** — the exception to the Motion rule, because the point is to
be seen to be a coin. It takes twice `--motion-slow` and ends on a whole
number of turns. Reduced motion shows the resting frame; the result is also
stated in text.

### The sample poll

The home page's *Example poll* and *Example result* tiles open it.

#### The sample poll is a recording, not rows

`/#/sample-dinner` is a three-question poll ("Movie night") still taking
votes; `/#/sample-result-dinner` is the same poll after nine people finished
it. Its questions ask progressively more — a bare list, a list with
descriptions, then a calendar (a Friday evening and a Saturday daytime) — so
both ballots are shown. Neither exists in Supabase: both are answered from
[`src/lib/samplePollData.ts`](src/lib/samplePollData.ts), which
`scripts/sample-poll.sh` generates by building the throwaway database, making
the poll **through the app's own functions** (`create_poll_group`,
`open_poll_submit`, `close_poll`), and recording what `open_poll_view`,
`open_poll_results`, `open_poll_ranking` and `open_poll_ballots` answer.

- **Nothing about the sample is computed in the browser.** Every number came
  from `star_round()` and `poll_ranking()`. To change what it shows, change
  the ballots in [`scripts/sample-poll.sql`](scripts/sample-poll.sql) and
  regenerate.
- **Nothing about the sample is in the database**, where it would be purged
  at six months and votable by anyone holding the link.

The generator pins ids and timestamps from each question's readable name, so
regenerating changes the file only where the poll changed. It keeps a
`sample.link` table for the run, mapping the real uuids to the readable names
substituted into the recording.

#### How the pages know

They do not. Every open-poll call goes through `openPollRpc` in
[`src/lib/samplePoll.ts`](src/lib/samplePoll.ts), the only thing that decides
what answers it. The `sample-` prefix cannot collide with a uuid, and the ids
are words so the links can be read aloud.

**The router must also recognise a sample id**: `PollPage` sends it straight
to `PublicPoll`, because asking the database about `sample-host` errors on the
uuid cast. `isSampleId` is exported for that. An unknown `sample-` id gets
`PublicPoll`'s *poll not found*, not the sign-in screen.

- **The data is `import()`ed**, not bundled.
- **The open copy takes a vote** and behaves like a real poll afterwards; the
  vote goes nowhere, as the poll's description says.
- **The vote lasts for the visit.** Ballots live in a module-level map in
  `samplePoll.ts`, and `PollPage` clears them (`forgetSampleBallots`) on
  leaving the poll routes, so a returning reader gets a fresh ballot. The
  strip's ticks go with them.
- **Its last ballot leads to the finished copy**: `nextUnansweredKey` plus one
  step for the sample alone. A revision moves nobody.
- **The sample is never subscribed to**; `PublicPoll` reads it once.
- **The home page's sample tiles open in this tab**; links off the site open a
  new tab.
