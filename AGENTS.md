# AGENTS.md

Working notes for this repo: how to set it up, how the pieces fit, and the
reasoning behind behaviour that would otherwise look arbitrary. The
[README](README.md) is deliberately kept to "what is this and why would I use
it" — everything technical belongs here.

## Stack and layout

React 19 + Vite, [Mantine](https://mantine.dev) for UI,
[Phosphor](https://phosphoricons.com) for icons,
[Supabase](https://supabase.com) for Postgres and auth, `react-router-dom` with
hash-based routing, deployed to GitHub Pages by
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml).

```
src/pages/       route components (SignIn, PollList, CreatePoll, PollDetail, PublicPoll, About)
src/components/  poll UI pieces (BallotCard, PollNotices, NameRoster, Results, Ballots, Respondents, CreatorControls, ConfirmOptions, …)
src/lib/         supabase client, auth context, share-link/QR/voter-key helpers, badge palette, field limits, settled-poll cache, per-browser ballot order and answered questions, the About page's sample poll, shared types
supabase/migrations/  the schema, as ordered SQL files
supabase/after-squash.sql  the statements a schema dump cannot carry
scripts/         squash.sh, which squashes the migrations and replays the above;
                 sample-poll.sh, which records the About page's sample poll
test/            tally tests, run against a throwaway Postgres; build-db.sh, which builds one
```

Scripts: `npm run dev`, `npm run build` (`tsc -b && vite build`),
`npm run lint` (oxlint), `npm run fmt` (oxfmt; `npm run fmt:check` reports
without writing), `npm run preview`, `npm test` (see [Tests](#tests)).

The formatter is configured in `.oxfmtrc.json` to the style the code was
already written in — no semicolons, single quotes, a hundred columns — and
skips Markdown, since this file and the README are wrapped by hand and the
wrapping carries meaning.

**One poll, two pages, one set of components.** A poll is read as an account
on `PollDetail` and through its link on `PublicPoll`, and an open poll is read
both ways by its own creator — so nearly everything a poll says about itself
has two callers reading two different pieces of state, `poll_status` on one
side and `open_poll_view` on the other. Anything both of them draw lives in
`src/components/` and takes what differs as a prop, rather than being written
out on each page:

- `BallotCard` is the ballot — the shuffled option rows, the stars, the error
  line, Cancel and Submit. The two pages keep a small component each
  (`VoteForm`, `OpenBallot`) holding the one thing that really is different:
  where the scores go. Those are genuinely two paths, with different grants
  and different guards, exactly as `submit_ballot` and `open_poll_submit` are
  two functions over one `replace_scores()`.
- `PollNotices` holds the sentences about where a poll has got to: what a
  collecting poll is waiting for, what a poll closed with nothing in it has to
  show, and when the results come out. The last of those is the two kinds of
  poll's one real difference at this point — an invite poll unlocks itself,
  an open poll is closed by its creator — so it takes which of the two it is
  as a prop and the wording is written once.
- `NameRoster` is a heading over a card of people, which is how the app
  answers *who* every time it is asked: who has voted, who has confirmed the
  options, and the invite list `Respondents` manages.

The rule this is holding up is that a poll cannot describe itself differently
depending on which door the reader came in by. Copies drift silently — the
same two sentences about changing your vote had already ended up laid out one
way on the ballot and another on the card you come back to — and the drift
always lands where nobody looks.

Icons come from [`@phosphor-icons/react`](https://phosphoricons.com), imported
by name: `<StarIcon size={20} weight="fill" />` rather than a `<path d="…">`
nobody can read at a glance. Import from the package root — it is ESM and
marked side-effect-free, so the bundler keeps only the icons actually named,
and the seven the app uses cost about 5 kB gzipped against a library of
several thousand. Mind the `Icon` suffix: the bare `Star`/`Sun` exports still
exist in v2 but are deprecated in favour of `StarIcon`/`SunIcon`.

The one `<svg>` left in `src/` is the QR code in `ShareQr.tsx`, which is a
path generated from the share link rather than an icon. `public/favicon.svg`
is a file the browser fetches, so it has no component to import either.

Two files exist only to keep a lint rule honest, and the rule is worth the
split: a module that exports both a component and a hook cannot be
hot-reloaded without discarding its state, which for the auth context means
being signed out on every edit. `src/lib/auth.ts` holds the context and
`useAuth`; `src/lib/AuthProvider.tsx` holds the provider and nothing else.
Every `useAuth` import still reads `from '../lib/auth'`, which is why the
split goes that way round.

The app is served under `/star-voting/` (see `base` in `vite.config.ts`) and
routes are hash-based, so it works as a GitHub Pages site with no
SPA-fallback configuration. Links into the app therefore look like
`https://choicelab.app/star-voting/#/poll/<id>`.

It's served from the custom domain `choicelab.app` rather than the default
`<username>.github.io/star-voting/` GitHub Pages URL. A custom domain is
served from its own root by GitHub Pages, with no automatic `/star-voting/`
prefix the way the default `github.io` project URL gets one — so that prefix
has to be built into the deployed files themselves, and choicelab.app is
meant to eventually host more than just this app. The setup:

- `vite.config.ts` sets `base: '/star-voting/'` and `build.outDir:
  'dist/star-voting'`, so the built app (and its asset URLs) live under that
  path rather than at the output root.
- [`site-root/`](site-root) holds what's served at the actual domain root:
  `CNAME` (read by GitHub Pages from the published artifact to map the
  domain) and an `index.html` that redirects to `/star-voting/`. The deploy
  workflow copies it into `dist/` after the Vite build, alongside the
  `star-voting/` subdirectory Vite produced.
- Once there's more than one app, `site-root/index.html` is where a real
  landing/directory page replaces the redirect.

DNS for `choicelab.app` needs an `ANAME`/`ALIAS` record (or the four GitHub
Pages `A` records, plus `AAAA` records for IPv6) pointing at GitHub Pages;
see [GitHub's custom domain
docs](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site).
Repo **Settings → Pages** should show the domain once DNS resolves, with
**Enforce HTTPS** enabled.

## One-time setup

### 1. Supabase

1. Create a project at [supabase.com](https://supabase.com). Recommended
   project-creation settings: **Enable Data API** on, **Automatically expose new
   tables** off (the migrations grant API access to exactly the tables and roles
   they need, so this isn't required), **Enable automatic RLS** on (a safety net
   for any table added later outside the migrations).
2. Connect the project to this repo under **Project Settings → Integrations →
   GitHub**, with `main` as the production branch. The migrations in
   [`supabase/migrations/`](supabase/migrations) are then applied for you — see
   [Database migrations](#database-migrations). Nothing needs pasting into the
   SQL Editor. No dashboard settings need changing for open polls either: the
   `anon` role's access is granted entirely by the migrations, and is limited to
   the `open_poll_*` functions (`view`, `submit`, `suggest_option`, `results`,
   `ballots`) — it has
   no read or write grant on any table.
3. Under **Project Settings → API**, copy the Project URL and `anon` public key.
4. The **Email** auth provider (magic link) is enabled by default — no extra
   provider setup needed.
5. Under **Authentication → URL Configuration**, set the Site URL to
   `https://choicelab.app/star-voting/` and add your dev URL
   (`http://localhost:5173`) to the allowed redirect URLs, or magic links
   won't be able to redirect back to the app.
6. Under **Database → Extensions**, check that `pg_cron` is enabled. The
   migration that schedules the nightly purge of expired polls enables it
   itself and shrugs if it cannot, so a project where it was unavailable ends
   up with the purge defined and never running — see [Polls are deleted after
   six months](#polls-are-deleted-after-six-months).

### 2. Local development

```bash
cp .env.example .env
# fill in VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
npm install
npm run dev
```

### 3. GitHub Pages deployment

1. Repo **Settings → Pages** → set source to **GitHub Actions**.
2. Repo **Settings → Secrets and variables → Actions** → add
   `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
3. Point the custom domain's DNS at GitHub Pages (see above), then push to
   `main` — the deploy workflow builds and publishes automatically, and
   GitHub picks up the domain from `site-root/CNAME` in the published
   artifact.

### 4. Emails

The app sends four, and every one of them goes through
[Resend](https://resend.com) from inside Postgres, calling Resend's HTTP API
directly with `pg_net`:

- **an invitation**, when an address is added to a poll's invite list
  (`create_poll` inserting into `invited_voters`, or the creator adding
  somebody later), through the `send_invite_email` trigger. It is two
  letters, not one: a poll still collecting its options asks for options,
  and a poll with a ballot on it asks for a vote;
- **voting is open**, when a poll that collected its options stops
  collecting, from `notify_poll_opened`;
- **the results**, when a poll finishes, from `notify_results_ready` — see
  [Telling people the results are
  ready](#telling-people-the-results-are-ready).

The senders themselves are in
[`0043_the_emails_a_poll_sends.sql`](supabase/migrations/0043_the_emails_a_poll_sends.sql),
which is also where the letterhead they share is written down; the triggers
that call them are in the squashed baseline under
[`supabase/migrations/`](supabase/migrations). Who hears which of them, and
who is deliberately told nothing, is [What a poll writes to
people](#what-a-poll-writes-to-people).

They all read the same key, and the API key is never
committed — they read it from Supabase Vault at send time:

1. In the Supabase dashboard, open the **SQL Editor** on the project (not a
   migration file — this is a secret, so it doesn't belong in the repo) and
   run:
   ```sql
   select vault.create_secret('re_your_resend_api_key', 'resend_api_key');
   ```
   Use a Resend API key scoped to sending only. If the key ever needs
   rotating, run the same command again with a new value — Vault stores
   secrets by name, so this updates it rather than creating a duplicate; if
   `create_secret` complains the name already exists, use
   `select vault.update_secret(id, 'new_key_value') from vault.secrets where
   name = 'resend_api_key';` instead.
2. That's it — no redeploy needed. The next row inserted into
   `invited_voters` (i.e. the next poll created with invitees) will pick up
   the key automatically, and so will the next poll to open and the next to
   finish.

This only works against a real Supabase project: `pg_net` and Vault don't
exist in the throwaway database `npm test` builds, so `send_poll_email` —
the one place this app talks to a mailer — checks for the schemas first and
quietly does nothing if either is missing. The emails are best-effort and
never block or fail the thing that triggered them.

One asymmetry is worth knowing before the key is in place: an invitation is
sent per insert, so a poll created later still sends its invitations, while
the other two are sent once, when the poll crosses the line — a poll that
opened or finished before the key existed is never announced. Nothing is
retried.

## Database migrations

Schema changes live as SQL files in
[`supabase/migrations/`](supabase/migrations), named so they sort in the order
they must run. They are **not** run by hand: Supabase's GitHub integration
watches this repo, and any new migration file that lands on `main` is applied to
the project automatically. Adding a schema change means committing the file and
merging it — check the Supabase dashboard afterwards to confirm the run
succeeded.

A migration that has already been applied is never re-run, so fixing a mistake
means adding a new migration rather than editing the old file. Since merging one
applies it to the live database, run `npm test` first — the suite builds a
database from these files, so it catches a migration that does not apply as well
as one that changes a result.

### Squashing

Migration files accumulate, and a long chain of them gets slow to run and hard
to read. Occasionally collapse the whole history into a single baseline file:

```bash
scripts/squash.sh
```

Use the script rather than `npx supabase migration squash --linked` directly.
The squash replays the migrations into a shadow database and pg_dumps the
result, so the baseline it writes describes the current schema and nothing
else. **A statement that does something rather than declaring something does
not survive it** — a backfill, a one-off `update`, the `cron.schedule()` that
runs the nightly purge. Those live in
[`supabase/after-squash.sql`](supabase/after-squash.sql), and the script
replays that file into a fresh migration on top of the new baseline. Anything
added there has to be idempotent: it is applied again on every rebuild, on top
of a database that may already have it.

The script also renames the squashed baseline to `<version>_baseline.sql`. The
squash writes the whole schema into the newest migration file and keeps that
file's name, which after a run of this script is the replay from the previous
one; the rename keeps the version prefix, which is the part Supabase's
migration history is keyed on, and changes only the label after it. It then
runs `npm test` and prints `supabase migration list` so local and remote
history can be compared before anything is committed.

Commit the result on its own, with no other changes in the same commit, so the
replacement is easy to review.

This is not a hypothetical: a plain squash silently dropped the purge schedule
once. `12_poll_retention` now asserts the job exists, so a squash that loses it
again fails the suite instead of quietly disabling retention.

## Tests

```bash
npm test              # every case
test/run.sh runoff    # only cases whose filename matches "runoff"
```

The election logic is the part of this app that can be wrong without looking
wrong: a bad tie-break produces a plausible winner, not an error. It also lives
almost entirely in Postgres, so that is where the tests are. `test/run.sh`
builds a throwaway database from `supabase/migrations/`, runs everything in
`test/sql/cases/`, and reports each assertion. The building itself is
`test/build-db.sh`, which is its own script because `scripts/sample-poll.sh`
needs the same database (see [The About page and its sample
poll](#the-about-page-and-its-sample-poll)).

Requirements are a Postgres server and a superuser role that can create
databases. `PGHOST`, `PGUSER` and friends are honoured, and with none set it
falls back to a local cluster. There is no test framework and nothing to `npm
install`. CI runs the same script against a `postgres` service container
([`.github/workflows/test.yml`](.github/workflows/test.yml)).

Getting to a server is `test/build-db.sh`'s job, and it is the same job for
`scripts/sample-poll.sh`, which arrives through the same file: start the local
cluster if one is installed and stopped (Debian's or Homebrew's), create a
role for whoever is running this if the install has none, and otherwise print
the install-and-start command for the platform rather than a sentence about
`PGHOST`.

**Superuser, because of who owns the schema.** Every table, function and view
in the migrations is `ALTER ... OWNER TO "postgres"`, and on a Homebrew or
Postgres.app cluster the bootstrap superuser is named after you instead. So
`test/sql/shim.sql` mints `postgres` alongside `anon`, `authenticated` and
`service_role`, as a superuser: the SECURITY DEFINER functions run as it and
read tables the shim itself owns, so an ordinary role only moves the failure
somewhere less legible.

### How a case is written

Cases seed through `create_poll()` and `submit_ballot()` rather than inserting
rows, so they cannot construct a state the app itself could not produce, and
each one rolls back at the end. A ballot set is a grid — one row per voter, one
column per option:

```sql
v_poll := tests.seed_poll(
  array['Apple', 'Banana'],
  array[[5, 4],      -- this voter scored Apple 5 and Banana 4
        [0, 1]]);
```

Assertions read the tally back **by option name**, never by id or by the
runoff's `a`/`b` labels. Options that tie on points are ordered by id, which is
the documented random tie-break, so those labels are not stable between runs.
`tests.prefers(t, 'Apple')` and friends in `test/sql/helpers.sql` exist to keep
cases off that ordering.

Expected values are worked out from the STAR rules by hand and written down
first — they are not copied back out of a passing run, which would only assert
that the code still does whatever it currently does.

### What it does and does not cover

Covered: the score round, finalist selection, both score-round tie-break rules,
the runoff and its tie-breaks, the genuine-tie result, the full ranking, the
`create_poll` / `submit_ballot` write path the seeding runs through, the two
windows in which a poll's option list may move — the collecting stage, and the
creator's own corrections before the first vote, who may say they are done
adding to that list and what happens when the last of them does — the two ways
a poll runs out of people to wait for, and the two reasons it can be waited on
after everyone has confirmed, the window in which a voter
may change their vote and the reveal that closes it, that an open poll's share
link discloses no email address, its creator's included, and which changes
announce themselves to which topics for [Live updates](#live-updates) — counts
as well as topics, since a change that announces itself once per row rather
than once per statement passes any assertion phrased as "did it say
anything" — and that a page of the poll list is a page of the same list every
time: that two pages partition it with nothing on both and nothing on neither,
that the total is of the list rather than the page, and that asking past the
end lands on the last page there is; everything about the results-ready
announcement except the sending — whether a poll has a result at all, who
would be told, and that the notice is made exactly once, forgotten on reset
and made again when the poll finishes a second time; and the same half of the
other emails — which invitation an address is owed at each stage a poll goes
through, that the creator is owed none, and who hears that a poll opened by
hand as against one that opened itself.

Not covered: RLS policies and the `auth.jwt()`-gated access rules. Nor the
sending of any email: `pg_net` and Vault do not exist in the throwaway
database, so `send_poll_email` finds no mailer and returns without doing
anything — the suite can say who *would* have been emailed and never that
anybody was, exactly as it can for live updates. Nor the
delivery half of live updates: `test/sql/shim.sql` keeps `realtime.send()`'s
write to `realtime.messages` and drops the service that fans it out, so the
suite can say who would have been told and never that anyone was. Everything
on the browser's side of the socket — `useLiveStream`, the debounce, the
retry — has no harness at all; this repo's tests are SQL. The shim in
`test/sql/shim.sql` stands in for Supabase's `auth` schema with a one-row
session table, which is enough to let the migrations apply and to sign a seeded
voter in, but it is not Supabase's auth and a passing suite says nothing about
who is allowed to read a poll. `run.sh` also drops three extensions a stock
Postgres does not have and the `MAINTAIN` privilege, none of which the tally
touches. A fourth, `pg_cron`, is not edited out here but guards itself in the
migration that wants it, so the retention rules are tested on a database with
no scheduler in it. Everything else is applied verbatim, so the functions under test are
the ones that ship.

## Live updates

Poll pages hold a websocket and re-read themselves when the database says
something moved, so votes appear without a reload.
[`src/lib/useLiveStream.ts`](src/lib/useLiveStream.ts) is the listening half;
`broadcast_poll_change()` and the triggers around it — in the squashed
baseline, then widened by
[`0035_broadcast_polls_to_watchers.sql`](supabase/migrations/0035_broadcast_polls_to_watchers.sql)
— are the telling half. This needs Realtime enabled on the Supabase project and
nothing else: broadcasting from the database writes to `realtime.messages`,
which needs no publication changes and no table grants.

**A signal, not the data.** Every message is empty. It says a poll changed and
refuses to say how; whoever hears it re-reads the poll through the same RPC
they would have called anyway. That is the whole reason this can exist without
unpicking the access rules. `anon` still has no read grant on any table, an
open poll's voters still reach their poll only through the `open_poll_*`
functions, and not one rule about who may see what had to be restated. The
alternative — subscribing to row changes directly — would have meant opening
those tables to `anon` and re-deriving every rule in this file as an RLS
policy, which is a second copy of the access model to keep in step with the
first.

**The topics are public, and that is a decision rather than an oversight.** A
listener needs no authorization because there is nothing to authorize: the
payload is `{}`, and the most anyone gains by guessing a topic is knowing that
a poll whose id they already held changed at some moment. It is still the RPC,
not the socket, that decides what comes back.

There are two kinds of topic:

- `poll:<id>`, for every page watching one poll, whichever side of it they are
  on. There were three kinds and this was two of them: an open poll was
  announced under its id *and* under its share token, because somebody
  arriving on `/p/:token` did not learn the id until they had read the poll
  once — and reading once before subscribing is what the second topic existed
  to avoid. A poll's id is its link now, so a voter arrives holding the topic
  and there is nothing left to bridge.
- `user:<id>`, for one person's poll list: every change to every poll on it,
  invites included.

**The list watches its reader, not its rows, and that is what keeps it to one
request.** It used to subscribe to one topic per poll on the page — a set it
could not name until it had read the list. So it read to learn its polls,
subscribed to them, and (because the first read happens on subscribe) read
again: two requests to draw one list, and a third every time a page was
turned. The circularity was never in the socket, it was in the topics.
`user:<id>` is known from the session before anything is read, so the page
subscribes on mount and reads once.

Widening that topic from "you were invited to something" to "something on your
list moved" also fixed two things that were quietly wrong. A vote in the
*second* question of a multi-question poll announced itself on that question's
topic, and the list carries the *first* question's row, so the group's "everyone
has answered" state moved with nobody listening. And turning a page cost a
re-subscribe on top of the read, where it now costs only the read — which,
since `0036`, is a read it genuinely needs.

**It does mean some reads are wasted, and that is the accepted trade.** The
topic wakes you for any poll you can see, while the page in front of you holds
ten — so a vote in a poll on page four re-reads page one to find it unchanged.
The alternative is subscribing to the polls on screen, which is the scheme this
replaced: it cannot name its topics until it has read, so it costs two requests
to draw the list and a re-subscribe on every page turn. One stable topic and an
occasional wasted read is the cheaper end of that trade, and each read is now a
page rather than a whole history.

The cost is worth stating plainly: a poll with forty invitees writes forty-one
messages per change rather than one. The fan-out to *sockets* is unchanged —
those forty were each already subscribed to the poll's own topic and each
already woke up — so what those extra rows in `realtime.messages` buy is one
round trip per reader, and the three fixes above.

Six rules keep it honest:

- **The first read happens on subscribe, not on mount.** A page that loaded
  itself and then subscribed would either read twice or leave a gap between
  the two for a vote to slip through unseen. Waiting for the subscription
  costs a handshake before anything appears and buys both problems away. It is
  also what makes reconnecting self-healing: Realtime does not replay what it
  sent while a socket was down, but rejoining a channel reports `SUBSCRIBED`
  again, and every one of those is a fresh read. A laptop that slept through
  four votes wakes up and asks. The one exception is the floor under that
  rule: taken literally it makes the websocket load-bearing for the poll
  appearing at all, so `FIRST_READ_MS` reads once anyway if subscribing has
  not worked in a few seconds. A network that blocks websockets costs live
  updates; it must not cost the poll.
- **Deletes are announced as loudly as inserts.** `reset_poll` clears a poll's
  ballots and a creator correcting the option list takes rows back off. A page
  told only about arrivals would sit there showing a tally that has just been
  thrown away, which is a worse failure than being slow.
- **One statement, one message.** The triggers are statement-level, so a reset
  clearing twenty ballots is one message rather than twenty, each of which
  would otherwise land on everybody connected. A poll on its way out is silent
  altogether: its rows cascade behind it, and `broadcast_poll_change` returns
  early when the poll is already gone, which is also what keeps the nightly
  purge quiet.
- **A read that fails is tried again, a few times, and then admitted to.**
  Polling used to cover this by accident — a dropped request was simply
  followed by another one five seconds later. Nothing follows a failed read
  now, and on the last vote of a poll there is no next signal to wait for, so
  `useLiveStream` retries briefly and then says so rather than leaving a page
  quietly wrong.
- **A hidden tab holds no socket.** Nobody is reading a backgrounded poll and
  twenty of them behind a closed lid should not each hold a connection open.
  Coming back re-subscribes, which re-reads, so returning to a tab shows what
  arrived while it was away rather than what was there when it left.
- **Watching stops when there is nothing left to watch.** A closed poll, or
  one whose results are out, has taken its last vote. The poll list is the
  exception and stays subscribed for as long as it is on screen: any poll on
  it can take a vote, and a new invite can add a row — which is why it watches
  its reader rather than any particular poll.
- **A vote *changed* says nothing at all.** The one deliberate silence here,
  and the reasoning is in [Changing your vote until the results are
  out](#changing-your-vote-until-the-results-are-out): nothing a watcher can
  see before the results unlock is derived from a score, and past the unlock
  no vote can change. A signal would wake everyone connected to re-read a poll
  and hand each of them the answer they already had. There is no trigger on
  `scores` and none on `UPDATE` of `ballots`.

**There is still no live indicator, and there is now one notice.** A page that
updates itself demonstrates that by updating itself; a dot claiming it does is
one more thing to read and one more thing to keep true. A page that has
*stopped* updating itself demonstrates nothing at all, and that is the one
state a reader cannot work out by looking — so
[`LiveConnectionNotice`](src/components/LiveConnectionNotice.tsx) says it, and
says what to do about it. It matters because there is deliberately no polling
fallback: a network that blocks websockets outright will serve every request
this app makes and still leave a page that never changes. Refreshing is the
fallback, so the notice asks for exactly that rather than inviting somebody to
wait for a reconnection that is not coming. `useLiveStream` sits on the state
for several seconds first, so a socket that drops and comes straight back
never reaches the screen.

One request per page on a first read, and one per change after that — the poll
list included. Turning a page of it costs one more, for the page itself; what
it no longer costs is a re-subscription, because the topic the list watches
does not depend on which polls are on screen. The pages carrying a
state badge can make a second: they ask `poll_winners()` for the finished polls
whose result they cannot already name, which is a request on a first look and
nothing afterwards. See [The poll's high-level
details](#the-polls-high-level-details) for why that is a request of its own,
and [Settled polls](#settled-polls) for why it stops.

In `npm run dev` every one of those appears twice: React's `StrictMode` mounts
each component, unmounts it and mounts it again, so every effect that fetches
or subscribes runs twice. That is development-only and deliberate — it is what
catches an effect whose cleanup does not work — and `npm run build` output does
it once. Count requests against `npm run preview`, not `npm run dev`. Against a
real Supabase project each request is also preceded by a CORS preflight
`OPTIONS`, so the browser's network panel shows two entries per call.

## Settled polls

Live updates are for what can change. This is its mirror image: a poll whose
results are out has taken its last vote, so its tally, its full ranking, its
ballot grid and the option it elected are fixed for good, and re-reading them
is work that can only ever produce the same answer. `src/lib/settled.ts`
remembers all four, and it is what makes the winner badge cost one request per
poll rather than one per refresh — and the full ranking one per tab rather than
one per time the modal is opened.

What it changes on screen: walking back into a finished poll draws it from
memory, with no skeleton and no request, and the poll list stops asking about
polls it has already asked about.

**In memory, for the life of the tab, and no further.** Nothing is written to
`localStorage`, and that is a decision rather than an omission. A settled poll
is settled *unless its creator resets it* — reset deletes every vote and
reopens the poll, which can then finish again with a different answer, and
[nobody is told](#creator-controls). So the bound on a wrong answer is kept
short:

- A reset **in this tab** clears the entries outright: `CreatorControls`
  calls `forgetPoll`, so the creator — the person most likely to look
  immediately afterwards — never sees the old result.
- A reset **somewhere else** leaves this tab holding a tally the poll no
  longer has. Every screen that renders one reads `poll_status` or
  `open_poll_view` first, and neither is ever cached, so a poll that has gone
  back to taking votes shows its ballot rather than a stale result. What is
  left is a poll reset elsewhere *and finished again* while this tab stayed
  open, which shows the previous answer until it is reloaded. Persisting any
  of this would turn that window into a permanent one, to save one request
  per poll per session.

Two properties make the cache safe to write to at all. Every RPC cached here
refuses to answer until the results have unlocked, so **holding a response is
itself proof the poll is finished** — there is no separate check to get
wrong. And nothing in it is secret: every entry is a response the server had
already decided this reader could have, dropped when the tab is.

`null` is a real answer in the winners map — a genuine tie elects nobody, and
so does a poll closed before anyone voted — so it is a `Map` with a `has`
check rather than a lookup treating *missing* and *empty* alike. Otherwise a
poll with no winner would be asked about forever.

## Waiting

A live page is the second read onwards; the first one has nothing to show at
all, and every one of those used to be the same spinner in the middle of an
empty column — the same mark whether what was coming was a poll list, a
ballot or a tally, with the page landing all at once underneath it.

`src/components/Skeletons.tsx` draws the shape of the page instead: the
list's cards, the poll's tag row, the score round's bars, the form's fields.
Two rules keep them from becoming a lie:

- **A skeleton claims only what the page always has.** The list draws three
  cards because the wait is over long before anyone counts them; it does not
  draw a winner badge, which most polls do not have. A placeholder for
  something that then fails to appear is a small lie the reader has to
  un-learn.
- **They all live in that one file**, so a page and its stand-in get changed
  together. The failure mode of skeletons is that they slowly stop resembling
  anything.

They are `aria-hidden`, wrapped in a `role="status"` that says *Loading* once:
the shapes are decoration, and what a non-visual reader needs is the word
they are miming. The one wait that is still a spinner is the app's own boot,
before the session is known — at that point there is no page to draw the
shape of.

## Behaviour worth preserving

These are decisions, not accidents. Changing any of them changes a promise the
app makes to the people voting in it.

### Poll settings are frozen at creation

Each poll fixes four things when it is created, and none can be changed
afterwards: `authenticated` has no `UPDATE` grant on the `polls` table at all.
A poll's terms are settled the moment it exists. Everything that *does* move
afterwards moves through a `SECURITY DEFINER` function with its own rules —
`close_poll`, `reset_poll`, `finalize_options`, `creator_add_option` — never
through a write from the client.

Three of the four are surfaced by `PollTags` (`src/components/PollTags.tsx`)
— always those three, always in the same order and the same words, whichever
way each one is set, on the poll list, the poll page and the public voting
page alike. A tag that appeared only for one of its two states made its
absence carry meaning, and nobody reads an absence. Showing both states of
each means the terms of a poll can be taken in at a glance and compared
between polls.

**Where the options came from is the one that is not shown.** It is frozen
like the other three and still true long after the poll ends, but it is the
one setting nobody scans for, and the row it was in had grown past what
anybody reads — five tags under a title is a row that gets skipped whole,
which costs the two tags that tell a voter what happens to their ballot. It
is stated in full while it matters, by the state badge reading *Collecting
options* and by the stage itself: a card that is a list with a box to add to
it is a poll taking its options from the people reading it, and it says so
better than the line of prose that used to sit under it — which is why that
line is gone.

`Collecting options` and `Closed` used to be appended to the same row as
neutral tags. They are not settings, they are where the poll has *got to* —
see [The poll's high-level details](#the-polls-high-level-details).

**Every state has its own colour**, not one colour per setting: with every
tag always present, a colour shared across a pair told you which question was
being answered but not what the answer was, leaving the text to carry the
whole tag. Colours come from `src/lib/badgeColors.ts`, which holds every badge colour
in the app in one place — badges from different files land side by side on a
poll list card, so choosing at the call site is exactly how two unrelated
meanings end up the same colour. Add a key there before adding a badge.

The wording is deliberately not symmetrical. Respondents are **shown** or
**hidden** — hiding them lists nobody at all, which is not the same as listing
them anonymously — while ballots are **published** or **private**. An anonymous
ballot is the two tags in combination: respondents hidden, ballots published.
Changing any of these strings means changing them in `PollTags` alone, which is
the point of it existing — the turnout wording included, which is why the count
badge takes the numbers and builds its own label rather than being handed one.

### The poll's high-level details

**One poll looks like one thing wherever it is read.** The card on the list,
the poll's own page and the public voting page share a heading, and share it
literally: `PollHeading` (`src/components/PollHeading.tsx`) is the one
component all three render, because three hand-written copies of one layout is
three things to keep in step and they had already fallen out of it. Four
parts, always in this order:

1. the **title**, with where the poll has got to in a badge beside it;
2. the poll's **description**, when it has one;
3. **who created it** — *Created by you*, or their email address;
4. the four badges saying **what kind of poll it is** — **invite only/open
   link**, then respondents shown/hidden, then ballots published/private, then
   how many have answered.

The order is not a preference. A description is the creator's own words about
the poll and belongs with the title it extends, above the row of app-written
badges rather than stranded under it. The three settings inside the row run in
the order `CreatePoll` asks for them, so the form that sets a poll's terms and
the row that reports them tell one story in one order; the count comes last of
the four because it is the only one that is not a setting at all. Two screens
describing one poll differently is two things to learn about a poll instead of
one.

`compact` is the list card — the same four parts at smaller sizes, because a
page title inside a link among nine others shouts.

**The public voting page draws three of the four, and the one it leaves out is
who created the poll.** That is the only place this heading is knowingly
incomplete, and the reason is worth writing down because the layout argument
points the other way.

Every email address this app displays anywhere is displayed to somebody who
is already in the poll it belongs to: an invite poll's roster is read by its
invitees, and nobody else can see the poll at all. **A share link has no such
boundary.** It goes wherever it is forwarded, to people who never signed in
and never will. Publishing the creator's address to all of them would be the
first time the app told an address to somebody outside the poll, and matching
three headings is not worth being that exception. `open_poll_view()` does not
return the column, so there is nothing there to leak by accident.

An open poll's roster is no counter-example: those names are typed into the
ballot by the voters themselves, not addresses the app knows about anybody.

**The winner's name is a different kind of thing, and this page does name
it** — in the badge, like everywhere else. It was never withheld here: the
tally under the heading has always named it in full. What was missing was the
name *in the badge*, because that comes from `poll_winners()` and that
function answers only to an account, so the badge read *Results ready* next to
a result sitting right underneath it.

**It is filled in from the tally the page already has, not from a request of
its own.** `Results` fetches that tally for itself on every screen that shows
one, and it carries `winner_id` and the option names — so the badge is drawn
from it, and running an election server-side to answer a question the browser
can already answer would be work for nothing. `Results` files what it learns
under the poll through `rememberWinner`, exactly where `poll_winners()` files
its answer, and the badge reads whichever arrives.

The two can never disagree: `winner_id` is `star_round()`'s first place, and
`poll_winner_name()` returns the *name* of `star_round()`'s first place. A
poll that elected nobody is `null` from both, which is a real answer and not a
missing one — see the table above.

Until that card lands, the badge renders **nothing at all** — see *The badge
waits for its own answer* below. That is the whole cost, and it buys the
public page a request it never makes and the server an election it never
runs.

**The badge waits for its own answer.** *Results ready* is a real state — it
means "finished, and nothing is going to tell this page what it decided",
which is true of a poll of several questions, of a browser talking to a
database older than `poll_winners()`, and of a request that failed. It is not
a loading state, and it used to be used as one: every finished poll drew
*Results ready* for the hundred milliseconds its winner was in flight and then
rewrote itself into a name, so every load of every finished poll flickered
through a state that was true for nobody. `PollStateBadge` now takes
`awaitingWinner` alongside `winner`, and draws nothing while an answer is
still coming. Each of the three screens knows its own answer to that:

- the poll page and the list ask `poll_winners()`, so "still coming" is "the
  request has not settled" — and it stops being pending **whether or not the
  request succeeded**, because a failure leaves the winner unknown and
  *Results ready* is exactly what unknown looks like;
- the list never asks about a multi-question poll at all, so that poll is
  never pending and its badge is there from the first paint;
- the public page's answer arrives from the tally card below it, so it waits
  for that card — and if that card fails there is no badge, which is the
  honest end of the same rule: the card says so itself, in red, where the
  tally would have been.

Nothing else on the badge waits. *Collecting options*, *In progress* and
*Closed* are decided by the read that drew the page, and a poll whose answer is
already in the browser — which is every poll opened from a list that has
already asked — draws it immediately.

**The badge and the title share a row, sixty/forty.** Two earlier attempts came
apart on a phone. Left free to give, the title took min-content and wrapped one
or two characters at a time down the side of a badge holding 220px of a 330px
card; pinned so the badge could not shrink, the row had to wrap and the badge
dropped onto a line of its own — a lot of vertical space for a word or two, and
it read as a second thing rather than as part of the heading.

So the split is stated rather than negotiated, in a `Flex` that never wraps:
the title's flex *basis* is 60% and the badge's ceiling is 40%. The slack goes
to whoever needs it, which is the half that matters — the badge is only as wide
as its text, so *In progress* asks for a fifth of the row rather than two
fifths, and the title grows into everything left over. Sixty is a floor, not a
serving. Past the ceiling it is the title that gives, wrapping inside its own
share, because a wrapped title is still readable and an elected option
ellipsised to two letters is not an answer at all.

**Only the badge carrying a poll's own text takes the ceiling.** Every other
state — *Collecting options* is the longest — is a fixed phrase the app wrote
and knows the length of, and keeps its width. Capping those at the same share
would ellipsise the app's own label to make room for a title, on exactly the
screens narrow enough for 40% to bite. The share answers "how much of the
heading may a poll's own text take", which is the only place the question is
really asked, so it lives on that one badge (`maw="40%"`, against the row)
rather than in a box around all of them.

Three decisions hold that shape:

- **Where the options came from is not in the row**, alone of the four
  settings — see above.
- **No badge in the row carries approval.** Both settings of both switches
  are the creator's to make, so neither state of a pair may look like the
  right answer. Ballots published/private was teal against pink until it read
  as green against red — a tick for publishing and a cross for not — and is
  now two greens, one hue family for one question, like the other two pairs.
  Approval belongs to the progress colours (`done`, `outstanding`), which are
  about getting somewhere rather than about a choice.
- **The count stays after the poll closes.** It used to be replaced by
  *Results ready* at exactly the moment it stopped being a moving number and
  became a permanent fact about the poll. While a poll is collecting options
  it counts options instead, because turnout is zero and stays zero until the
  list is settled.
- **"Vote pending" is gone.** It answered a question about the reader rather
  than about the poll, which is what the rest of the row is for.

The count is on every one of those screens, including the public voting page
and including before the reader has voted — see [Whether respondents are
shown](#whether-respondents-are-shown) for why it is the roster that waits and
not the number.

The state badge says *Collecting options*, *In progress*, *Closed*, or **the
option that won**. A finished poll naming its winner is the answer the whole
poll was for, and the reason anybody opens one again months later.

Two things it deliberately does not do. It does not prefix the name with
*Winner:* — the badge is green, it sits where every other poll's state sits,
and the polls around it read *In progress*; a label naming the question is
only worth its room when the answer alone would be ambiguous. And it does not
collapse the three finished outcomes into one:

| Badge | Means |
| --- | --- |
| the option's name | STAR elected it |
| *Tied — no winner* | the election ran and settled nothing — see [Tie-breaks](#tie-breaks) |
| *Results ready* | finished, and this page has not been told which of the two |

That last row is a real state rather than a fallback: the name always arrives
behind the page — in a `poll_winners()` request on the poll list, or with the
tally on a page that shows one — and a browser talking to a database older
than `poll_winners()` never learns it at all. It must never read as *Tied*,
which would be a wrong answer where this is only a missing one.

The name comes from `poll_winners()` (`0024`), which calls
`poll_winner_name()`, which runs the same `star_round()` the results page
runs — so the badge and the poll page cannot disagree about who won, because
there is one implementation of the method and this is a second caller of it.

**It is a separate request, not a column on `list_polls()`, and that is the
whole design.** Running STAR is not free, and the list re-reads itself every
few seconds for as long as it is on screen; a `winner_name` column would have
re-run every finished poll's election on every tick, for an answer that
cannot change. Instead:

- `list_polls()` stays what it was — one cheap `STABLE` query per tick, with
  no election in it.
- The page asks `poll_winners()` for the finished polls **on the page being
  looked at** that the browser cannot already name. That is at most ten, it
  happens the first time a page is looked at and on the tick a poll's results
  unlock, and it happens not at all in between (see [Settled
  polls](#settled-polls)).

So the cost is one election per poll per tab, rather than per poll per tick —
it stops growing with the length of your poll history, which is what a badge
on a list has to do.

`poll_winners()` checks visibility itself, on exactly the terms `list_polls()`
uses, and answers with **no row at all** for a poll the caller cannot see:
*not yours* and *no winner* are different answers and must not arrive looking
alike. It also refuses more than 200 ids in one request, because each one is
an election.

**A page that already shows a tally does not go through it at all**, and the
public voting page could not anyway — it has no account to ask with. It takes
the winner out of `Results`' own tally instead, through the same
`rememberWinner` the list writes to. So the function is asked only where there
is no tally on screen to read the answer off: the poll list, and a poll page
opened before its results card has loaded.

A browser holding a build newer than the database it is talking to reads
*Results ready* too — the app deploys on push while migrations land on merge,
so for a few minutes `poll_winners()` may not exist yet. That failure is
swallowed on purpose: a list with no winners named on it is a working list,
where a list that 404s is not.

The poll page asks the same function through `useWinner`, and through the same
cache, so opening a poll from the list — which is how most people open one —
costs no request at all and cannot disagree with the card it was opened from.

**Ten polls to a page, taken in the database.** `list_polls(p_limit,
p_offset)` returns that page and the total, in one round trip.

It used to return everything and let the browser slice it, defended on the
grounds that a poll history is "a number in the tens". The flaw in that was
never the row count — it was that the expensive half of `list_polls()` is a
set of correlated subqueries run *per poll* (the invited, voted and option
counts, plus a `bool_and` pass over every question in a group for each of
`voted`, `is_complete` and `is_closed`). Reading the list whole paid that for
every poll you had ever been invited to in order to draw ten. So the page is
taken before the aggregates run: `page` slices `visible`, and `tallied` reads
from `page`. What still costs one pass over everything visible is the total,
which is a count and cannot be anything else.

**The index matters more than the paging did.** `polls.created_by` had a
foreign key and no index, and Postgres does not create one for a foreign key —
so the "mine" half of the visibility test had nothing to use, an `OR` with an
unindexable side cannot become a bitmap union, and the planner was left
scanning `polls` in full, every user's polls included, to answer a question
about one person's. That was the only cost here that grew with *other
people's* data, and paging could never have touched it: the filter runs before
the page is taken. `0036` adds the index.

**Asking past the end lands on the last page there is**, and the clamp is in
the database. The browser derives its page count from the same total, so the
page it claims to be showing and the page it was handed cannot drift apart —
and an empty answer means an empty list rather than a page number that
overshot. A poll deleted from page three still leaves the reader on page
three, or on the last page if that was it.

**Paging is ordered by `created_at desc, id desc`.** Offset paging is only
correct over a total order — two rows that compare equal may come back either
way round, and then a row lands on two pages or on none, silently. In the app
polls are created one at a time and their timestamps differ, so the tiebreak is
insurance; nothing *enforces* that they differ. In the suite it is
load-bearing, because a case is one transaction and every poll a case creates
shares a `created_at` to the microsecond — which is why
`20_paging_the_poll_list` can assert that two pages partition the list at all.

**Both arguments are required, and there is no "all of them" mode.** A default
page size in the database would be a second copy of `PAGE_SIZE` to keep in step
with the browser's, and an unlimited mode would be the whole-list read this
change exists to stop being the normal path.

### Option descriptions

An option can carry a description as well as a name: a caveat, a couple of
lines of detail, a link to whatever is being voted on. It is optional and
nearly always absent, and `0019` is the migration that gave `create_poll`
somewhere to put the text. The column itself predates that by a long way:
`candidates.description` and both ballots' rendering of it were written first,
and nothing had ever been able to fill it in.

**Whether the field is on screen depends on how many options are.** The create
form lays out a dozen option rows at once, so a description under every one of
them would bury the list the creator is trying to read; each row has a `+`
beside it that opens one instead. `CollectOptions` — the box on a poll
collecting its options, and the creator's own correction of a settled list — is
one option at a time, so the field is simply there, costing two rows of a card
with nothing else in it. The `+` was a control that had to be found and pressed
before the most useful thing a suggestion can carry could be typed, in the one
place where nothing was competing for the room. It has no open/closed state
there at all: the string is the whole of it, and empty means no description.

The field it opens says what it is by its shape. It is indented under the
option it belongs to, with an elbow drawn from the bottom of the name field
across to its left edge (`DescriptionField.module.css`) — indenting alone reads as an
unrelated field that happens to be narrower, and the elbow is the shape a file
tree already uses for "belongs to the thing above". It opens two rows tall
rather than one, because a field the same height as the name above it looks
like another one-line answer, and it grows from there instead of scrolling.
Its placeholder names its option — *Option 2 description* — so a form with
several of them open cannot be misread.

Four things hold it together:

- **Descriptions are paired with options by position, and filtered with them.**
  They travel to `create_poll` as a second array, so dropping a blank option row
  without dropping its slot in that pairing would slide every later description
  one option up — not an error anywhere, just the wrong text under the wrong
  name. `CreatePoll` filters the pairs and `create_poll` aggregates both
  columns in one pass, and neither ever filters one array alone.
- **Hidden means gone.** In the create form, collapsing the field discards what
  was in it rather than remembering it, so a poll can never carry a description
  its creator can no longer see. It is also why "no description" is `null`
  rather than an empty string there: the same value collapses the field and
  means there is nothing to store. `CollectOptions` has no collapsed state to
  represent, so its description is a plain string and empty is the whole of
  "none".
- **They belong to the ballot, and are folded away everywhere else.** Both
  ballots show one under the option's name, because that is where the detail is
  a voting aid. The results do not: a paragraph beside a bar of points is noise
  at the point where the decision has already been made. But it is also the
  only record of what the option *was*, and it used to vanish from the app
  entirely the moment a poll closed — so the score round carries one dimmed
  mark beside the options that have a description, and nothing at all beside
  the ones that don't, opening it in a popover. A popover rather than a
  tooltip, because a tooltip on a phone is a thing that cannot be opened. The
  full ranking and the published ballot grid still name options and nothing
  more — `poll_ranking` does not return a description at all.

  The text reaches the results through `poll_tally`, which carries a
  `description` on each option in the score-round list (`0023`). No new access
  comes with it: descriptions travel with the results, on the same terms, to
  the people the results already reach.
- **URLs in them are links.** Pointing at something else is most of the reason
  to write a description at all, and a link nobody can click is one the reader
  has to select and copy. `OptionDescription` turns `http(s)://` and bare
  `www.` runs into anchors as React elements — no HTML is ever parsed out of
  the text, and the `href` is either the matched URL or `https://` glued onto
  the `www.` form, so a description cannot produce a `javascript:` link.

**An option name may be 150 characters and its description 900**, and they
were 100 and 500 until
[`0037`](supabase/migrations/0037_longer_option_fields.sql). Both were chosen
when suggestions were the only way into `candidates`, and both turned out to
be a size smaller than what people write: 100 was a *label's* length rather
than an option's — real options carry a subtitle, an author, a year, a
"(vegetarian)", and a writer eight characters over the line was being asked to
abbreviate the thing being voted on so that the ballot read worse — and 500
was one paragraph of description where people were writing two. The reason for
a ceiling is unchanged and is not about taste: the suggestion path lets a whole
group write to this table, so every field it can reach needs a bound.
`insert_option` is the one place either is applied, because both the creator's
path and the suggestion path arrive there; `src/lib/limits.ts` carries the same
numbers for the form, which is where a writer is told which field is too long
and by how much.

Like everything else about a poll, a description is fixed at creation; the
options of a poll with votes in it cannot change at all
(`guard_options_frozen`). Duplicating a poll copies the descriptions with the
options, which is the only way to get a nearly-identical poll with the
explanations intact.

### Who can vote

|  | **Invited people** | **Anyone with the link** |
| --- | --- | --- |
| Access | Email addresses on the invite list | An unguessable link — the poll's id |
| Voter signs in | Yes, magic link | No |
| Results unlock | When everyone invited has voted, or when the creator closes the poll | Only when the creator closes the poll |
| One vote each | Enforced — one ballot per account | **Not** enforced |

An open poll cannot tell its voters apart. Anyone the link reaches can vote, and
one person can vote more than once from another browser or after clearing site
data. The app stores a random key in `localStorage` (see `src/lib/voterKey.ts`)
to stop accidental double-submits, but that is a convenience, not a guard. Open
polls are for picking a movie; invite polls are for anything where the outcome
matters.

Results stay hidden until they unlock in both modes, so nobody ever votes
knowing how it is going.

### A poll's link is its id

**One address, `#/polls/<id>`, for every poll and every reader of it.** There
were two: open polls lived at `#/p/<share token>` and everything else at
`#/polls/<id>`, so an open poll's creator was permanently looking at an
address that was not the one to hand out. Copying what was in front of them
sent the recipient to a sign-in screen and then to *poll not found* — a
failure with no clue in it, arrived at by doing the obvious thing.

**The token and the id were the same thing twice.** `insert_poll_row` minted
the token as `replace(gen_random_uuid()::text, '-', '')`: 122 bits from the
same generator that fills the primary key. Neither was guessable and neither
was more unguessable than the other, so the separation never bought entropy.
It bought exactly one thing, and it is the thing that was given up here.

**What did not change: who can reach an open poll.** For an open poll the id
was never the wider of the two. `polls_select` is `created_by = auth.uid() or
is_invited_to_poll(id)` and an open poll has no invitees, so its creator was
the only person who could learn the id without holding the link — and
`open_poll_view` has always returned the id to anyone presenting the token.
The set of people who can vote in a poll is the set it was.

**What was given up, plainly.** Two things, and neither is hypothetical:

- **A leaked link can no longer be replaced.** The id is referenced by
  `candidates`, `ballots`, `invited_voters` and `polls.group_id`, so there is
  no rotating it. "I pasted my poll link in the wrong channel, send me a new
  one" now has no answer but to duplicate the poll and lose its votes. With a
  separate token that was an `UPDATE`.
- **A primary key travels where a single-purpose secret does not.** This
  schema already writes poll ids into email bodies — every email this app
  sends links to `#/polls/<id>`. Those only go to invite polls, so nothing
  leaks today; but the pattern is established,
  and every future thing that logs, exports, or reports an id is now handling
  a ballot rather than a row number. That is the standing cost of the merge
  and the reason to think twice before adding the next one.

**Deployed links broke.** There was no compatibility shim: `0039` drops the
column, so an `#/p/<token>` link already out in the world has nothing left to
resolve against. That was a deliberate call, taken while the polls in flight
were few enough to be worth less than the shim.

**One address means the route has to decide what the reader may see**, since
the URL no longer says. `App.tsx`'s `PollPage` does it in the order that costs
least:

1. **A sample id?** Render `PublicPoll` and stop, whoever is reading. The
   About page's sample is answered from a file in this browser and is not a
   row anywhere, so there is no account reading of it to try — and `polls.id`
   is a `uuid`, so asking the table about `sample-host` does not come back
   empty, it errors. See [The About page and its sample
   poll](#the-about-page-and-its-sample-poll).
2. **Signed in?** Render `PollDetail`, which reads the `polls` row as its
   first act anyway. Row-level security answers exactly the question being
   asked — a row for the creator and for an invitee, nothing for anyone else —
   so it reports *I cannot see this* rather than drawing *poll not found*, and
   `PollPage` falls back to the public reading. Probing first would have
   charged every creator opening their own poll a round trip to learn what the
   read they were about to make already knew.
3. **Not signed in, or refused above?** Render `PublicPoll`, which reads
   through the anon RPCs and can therefore only ever show an open poll.
4. **Refused there too, and signed out?** Offer the sign-in screen rather than
   a dead end. The visitor may be on an invite poll's list — every invitation
   email links to exactly this address — so where they were headed is stashed
   through `rememberDestination` and the magic link brings them back to it.
   Signed in and refused twice, the link really is dead, and `PublicPoll` says
   so.

### Whether respondents are shown

- **Shown** — everyone in the poll can see who has responded and who hasn't,
  while voting is still open. Invite polls list the invited email addresses;
  open polls ask each voter for a name and list those. Useful when you want to
  know whose vote you are still waiting on.
- **Hidden** — only the number of votes is shown, to everyone including the
  creator.

This controls *who responded*, never *how they voted*.

**A poll that shows its respondents shows them, and there is no second rule
about when.** One setting decides, and it is the setting stated on the tag
beside the title; everyone in the poll reads the roster from the moment the
poll exists, whatever stage it is at and whether or not they have voted
themselves.

It was not always this. The roster used to be held back until you had voted,
on the reasoning that watching it fill up is a live feed of the *arrival
order* — names attached to the moment each one arrived, which is what the
published ballots work to keep off the record by sorting themselves on
`md5(id)` rather than on time. The roster itself is alphabetical (`order by
lower(voter_name)`), so the leak was in watching it grow rather than in reading
it once, and withholding it until you voted narrowed that window without
closing it: a voter still saw everyone who arrived after them. What it bought
was a partial fix to a leak the *setting* already opts into; what it cost was
one card behaving three different ways depending on who was reading it, how far
through they were, and whether the results were out — and, once the collecting
stage grew a roster of its own, a rule about ballots being applied to a card
that was answering a question about options. The trade came out the other way
round, so the embargo is gone and the two exemptions that used to soften it
(the creator, and a poll whose results are out) are gone with it: there is
nothing left for them to be exemptions from.

The setting is what a poll promises and it is on screen before anybody votes,
so nothing here is discovered after the fact. The one guarantee this does
weaken is the arrival-order one, and the place that guarantee is actually kept
is the ballot ordering — see [Whether ballots are
published](#whether-ballots-are-published), which is why that ordering is a
hash rather than a nicety.

A bare count leaks neither half. It names nobody, and it says nothing about
any ballot — so it is on every screen a poll appears on, before you vote and
after. What a poll keeps from its voters is how it is **going**, and turnout
is not that: the standings stay sealed until the results unlock, in both
modes, and no count moves them. The poll list has shown `3/6 voted` for polls
you had not voted in since long before this was written down, which is the
app's actual position on whether the number is secret.

**What the roster answers changes with the stage; who may read it does not.**
While a poll is still collecting its options nobody can vote, so the badge
beside each name says *Confirmed* or *Pending* rather than *Voted* or
*Pending* — see [Saying you are done adding
options](#saying-you-are-done-adding-options). The heading over it says
*Voters* throughout, because it is one card about one set of people and
renaming it halfway through the poll would read as two.

**Turnout is reported in exactly one place on any screen**, and that place is
the count badge in the poll's header — the same badge, in the same position,
on the list and on the poll's own page. One fact stated twice reads as two
facts that happen to agree, which is why the results no longer open with "6 of
6 invited voters participated", why neither roster carries a count of its own,
and why the **Confirm options** button says what pressing it will do rather
than how many people have already pressed it. The badge counts confirmations
while the poll is collecting its options and votes once it is taking them; it
is the same badge counting the same list of people either way.

That leaves the roster answering *who* and nothing else, and it means a poll
that hides its respondents renders no card at all for anyone but its creator:
the header has already said how many voted, and the *Respondents hidden* tag
beside it has already said why nobody is named underneath. The creator still
gets the list, because for them it is the invite list they manage rather than
a roster of who voted — and on a hidden poll it comes back with no per-person
status, which the card says in a line.

### Whether ballots are published

- **Not published** (the default) — results come back only as an aggregate
  tally. Nobody, the creator included, can read an individual ballot through the
  API.
- **Published** — once the results unlock, every ballot is readable as a grid:
  one row per voter, one column per option, with the column totals matching the
  score round. The poll becomes auditable — anyone in it can check the
  arithmetic instead of trusting it.

This is independent of who-responded, and all four combinations are useful:

|  | **Ballots not published** | **Ballots published** |
| --- | --- | --- |
| **Respondents hidden** | Fully private | Anonymous ballots — a verifiable tally that names nobody |
| **Respondents shown** | A roster of who voted, totals only | Fully auditable — every ballot, with a name on it |

Four rules hold the published setting together:

- **Ballots unlock on exactly the same terms as the results** — completion or
  close, never earlier. A published poll is still a secret ballot while it is
  running, so no vote is ever cast knowing how it is going.
- **The creator gets no exception.** Hiding ballots is a promise made to the
  people who voted, not an access level, so an unpublished poll's ballots are
  unreadable by everybody.
- **Voters are told before they vote.** Whether the scores will be published,
  and whether a name will be attached, is on screen and readable before
  anything is sent — nothing about a ballot can be discovered only after it is
  cast. This is `PollTags`' job: both pages that carry a ballot put the tags
  above it, so the terms are stated where the ballot is cast rather than in a
  settings summary elsewhere.

  This used to be a boxed `Alert` under the submit button as well, spelling the
  same two facts out in sentences. It was removed once the tags covered both
  states of all four settings: the alert restated what the tags already said,
  and a warning that repeats the label six inches above it trains people to
  skip both. The requirement is that the voter can read the terms before
  submitting, not that they are said twice.
- **Anonymous ballots are ordered by a hash of their row id, never by submission
  time.** This matters, and it matters more than it used to: on an open poll
  that shows respondents, names appear in the voter list as people vote, and
  since the roster is no longer [held back until you have
  voted](#whether-respondents-are-shown) anyone refreshing the page while
  voting is open learns the arrival order. Handing ballots back in submission
  order would re-attach those names to ballots the poll deliberately left
  unnamed. This ordering is now the whole of what keeps them apart.

One honest caveat about "anonymous": it describes what the app publishes, not
what the database forgets. An open poll that hides respondents genuinely never
stores a name — `open_poll_submit` discards one whatever the client sends. An
invite poll always stores the voter's account id, because that is how it
enforces one ballot each; hiding is a policy applied over data that still
exists, and anyone with direct database access could undo it. The stronger
guarantee needs an open poll.

### Where the options come from

Two answers, and the second one gives a poll a stage it did not have before.

- **From the creator** (the default) — the options are written in the create
  form and exist the moment the poll does. This is every poll the app made
  until `0020`.
- **From respondents** — the poll opens as a list rather than a ballot.
  Everyone in it can add options, nobody can vote, and it stays that way until
  the creator finalizes the list. Voting opens then, and from that point the
  poll is indistinguishable from any other: same ballot, same tally, same
  rules about who may see what.

`solicit_options` is the setting and is frozen like the other three; it says
where the options came from, which is still worth reading long after the poll
has closed. `options_finalized_at` is the *state*, and moves exactly once. A
poll is **collecting** when it solicits options, has not been finalized, and
has not been closed — derived in the database rather than stored, the same way
`is_closed` is derived from `closed_at`, so the two can never disagree.

The one promise this stage makes is that **everyone who votes scores the same
list**, and every rule under it is holding that up:

- **Nobody votes while the list is growing.** Both `submit_ballot` and
  `open_poll_submit` refuse, so a page left open across the transition cannot
  slip an early ballot in — and an early ballot would be answering a different
  question from everyone else's.
- **Nobody suggests once it is finalized.** The finalized list is the one every
  voter is scoring, so it cannot grow underneath them. After the first vote
  `guard_options_frozen` holds it there for good, exactly as on any other poll.
- **Only the creator finalizes, and only into a real ballot.** Two options
  minimum — the same floor `create_poll` puts on a poll whose creator wrote the
  options, applied at the point the list becomes a ballot instead. A soliciting
  poll may therefore be created with no options at all; seeding a few is a head
  start, not a requirement. The button that does it is **Open poll**, and it is
  in `CreatorControls` with the rest of the lifecycle — see [Creator
  controls](#creator-controls).
- **Everyone suggests through a function, the creator included.** An invitee
  has no `INSERT` grant on `candidates` and `anon` has no grant on any table, so
  `suggest_option` (invite polls) and `open_poll_suggest_option` (open polls)
  are the only ways in. One path means the rules are stated once, and the
  creator's list cannot be built under rules nobody else's is — the same reason
  the creator votes in their own open poll through the `anon` RPC.
- **Suggestions carry no name.** Who suggested what is a third disclosure
  question on top of *who responded* and *how they voted*, and the poll's tags
  answer neither of those about the option list. Storing a name nothing
  displays would only be a leak waiting to happen.

Two caps exist on the suggestion path and nowhere else, because this is the
only field in the app a whole group can write to rather than the poll's creator
alone: 100 characters on a name, 500 on a description, and 50 options in a
poll. None is near what a real suggestion needs, and the last one is really
about the ballot — a list nobody will read to the end is not one anybody can
score honestly.

The stage is surfaced by `CollectOptions` (`src/components/CollectOptions.tsx`)
in place of the ballot, on all three pages that can carry one, and **built the
way the ballot is built**: the name field at the top, the strip of the poll's
other questions under it, the list itself, and what happens next beside the
button that ends your part in it. It is the ballot's stage, at the ballot's
address, in the ballot's place on the page, so a reader who has done one should
recognise the other rather than meet a second layout with the same parts in a
different order. Everyone sees the same list, the same box to add to it, and
the same button to say they are done with it — see [Saying you are done adding
options](#saying-you-are-done-adding-options), which is where that button comes
from and why it belongs in this card rather than beside the poll's other
controls. The creator additionally gets a
`×` on each row, which sits beside the list it acts on rather than in
`CreatorControls`, the same way the invite controls sit inside `Respondents`.
Ending the stage is the other way round — that is something the creator does
to the *poll*, so **Open poll** is in `CreatorControls`.

**Reset votes leaves a finalized poll finalized.** Resetting promises the same
poll with its votes cleared, and the list everyone was shown is part of the
same poll. A poll closed while it was still collecting does reopen collecting,
because that is the stage it was in.

### Saying you are done adding options

The collecting stage reported one number and it was the wrong one. "Seven
options" is seven people with an idea each or one person with seven, and
neither is distinguishable from a poll nobody has opened — so the only way to
end the stage was to guess when the list had stopped moving, and the person
guessing was the one who could least afford to be wrong about it. **Confirm
options** is the missing half: one press per person saying they have looked and
have nothing more to add. `0041` adds it.

**It says "I have had my say", not "I approve this list".** That is
deliberately the weaker of the two readings, and it is what makes the signal
stable: a suggestion arriving after somebody confirmed does not un-confirm
them, so one late idea cannot keep a poll collecting for ever. The promise that
**everyone who votes scores the same list** is kept where it always was, by the
moment the list is finalized — this changes nothing about it and is not a
second mechanism for it.

**A confirmation is per question, like a ballot**, because a question is a poll
here and each one carries a list to have a say about. Opening is the act that
spans the group, so the poll opens itself only when every invitee has confirmed
every question in it.

**So the stage carries the question strip, and the strip marks it.** A poll of
five questions collects five lists, and the card that collects them had no way
between them at all — the strip arrived with the ballot, one stage too late,
which left the other four lists reachable only by going back to the poll list
and in. It is the same strip in the same place inside the card, and pressing
*Confirm options* moves the reader to the next list they still owe exactly as a
first ballot moves them to the next question. `0042` gives `poll_group` the
flag it draws the mark from — `confirmed` per question, beside the `voted` it
already returned — and the open side answers it from the browser for the reason
it answers `voted` from the browser; see [A poll can ask more than one
question](#a-poll-can-ask-more-than-one-question). The badge means *this
question is behind you*, and which of the two facts makes that true is whichever
stage the poll is in.

**Only invitees confirm, exactly as only invitees vote.** `submit_ballot`
refuses anybody off the list and `confirm_options` refuses them in the same
words, which is what keeps the roster complete: everyone who *can* confirm is
on it, so a page can render "3 of 6" and mean it. A creator who did not invite
themselves adds options like anyone else and says they are done by pressing
**Open poll**, which was always their version of this. One who invited
themselves is an invitee like any other and confirms with everybody else —
`poll_status` returns `invited` to tell the page which of the two it is looking
at, since being able to *read* a poll is not the same question.

**It can be taken back, for exactly as long as it can be given.** Confirming is
one click that can open a poll for everybody, and the honest counterpart of a
button that does something irreversible is one that undoes it while it still
means anything. Once the poll opens there is nothing left to be done adding to,
and both functions refuse — the same door `suggest_option` closes, in the
same words, at the same moment.

That undo is **Edit options**, and for a while it was a promise the database
kept and the screen did not: `unconfirm_options` and
`open_poll_unconfirm_options` shipped with `0041` and nothing called them.
Confirming replaced the card with the same card, minus its button, and the
only way back to the list was to have not pressed it. It is now the ballot's
own shape one stage earlier — **you're done adding options**, what happens
next, and the way back to the list beside it, exactly as *your vote is in*
carries *Edit vote* — because it is exactly the same promise: a decision that
stands until the moment it stops meaning anything, and is yours until then.
Pressing it withdraws the confirmation on the server rather than only on
screen, so the count and the roster it was in move with it; there is nothing
half-confirmed to leave behind.

**A poll with participants opens itself when the last one confirms.** That is
the whole point of collecting the signal, and `open_options_when_all_confirmed`
is the whole of it. Two things about that function matter more than what it
does:

- **It returns rather than raises on every reason not to open.** It runs inside
  somebody else's confirmation, and neither that person nor the person being
  removed from an invite list asked for the poll to open. The case this is
  really about is the two-option floor: a group whose questions do not all
  clear it would otherwise fail one person's button for a rule about a question
  they were not looking at. The creator still has **Open poll**, which names
  the short question and says why.
- **Taking somebody off the invite list runs the same check**, because that is
  the other way a poll runs out of people to wait for — "we are waiting on
  Bob, and Bob is not coming". Their confirmation leaves with them, so
  re-inviting somebody asks again rather than counting an answer they gave to
  another list.

**An open poll opens itself never.** It has no participant list, so there is no
set of people who could all have confirmed; anyone holding the link can confirm
and no number of them means the stage is over. Its creator ends it, as before.

**A share link asks for a name, because it has nothing else to go on.** An
invite poll knows who is confirming from the session and annotates the invite
list it already draws. Behind a link there is no account, so a bare count would
answer *how many* when the question being asked is *who* —
`open_poll_confirm_options` demands one and refuses without it, in the same
words and the same order `open_poll_submit` demands one for a ballot. A poll
that **hides its respondents** is the exception and keeps the promise
[Whether ballots are published](#whether-ballots-are-published) makes for it:
no field, no name stored whatever the client sends, and a count. The name is
offered back from `lib/voterName.ts` like a ballot's, so confirming and then
voting is one name typed once.

**Who reads it is the roster question, answered by the roster's setting.** Who
has confirmed is the same disclosure as who has voted — a list of names — so
it is decided by the same setting, through the same column of
`poll_invitees`, and read by everyone in the poll from the moment there is
anything to read. There
is no second rule about when, here or on the voter roster: needing one for this
card is what finally settled that the other card should not have one either.
See [Whether respondents are shown](#whether-respondents-are-shown) for the
embargo that used to be there and why it went.

**The badge answers the question the poll is asking; the heading does not
change.** `Respondents` draws *Confirmed*/*Pending* while the poll is
collecting and *Voted*/*Pending* afterwards, off `status.soliciting` rather
than an idea of its own — nobody can vote yet, so a column of *Pending* would
be answering a question nobody asked. The heading over it stays *Voters*
throughout: it is one card about one set of people, and renaming it halfway
through the poll would read as two cards rather than as one card keeping up.

**The count is in the count badge, and nowhere else.** While a poll is
collecting, the badge beside its title reads `2/5 confirmed` on an invite poll
and `3 confirmed` on an open one — the same shape as the `3/6 votes` and `3
votes` it gives way to, out of the same denominator, so a card carrying one
today and the other next week is counting the same list of people both times.
It replaces the option count that badge used to show at this stage, which was
the wrong number for the reason at the top of this section. `turnoutLabel` in
`PollTags` still falls back to the option count when `confirmed_count` arrives
undefined, which is a browser running ahead of the migration; a confident zero
would be a lie where the old number is merely old.

The line under the name field went the same way, and for a nearer reason: it
said *confirm the options once you have nothing more to add*, which is about
the button rather than about the name, and it sat on a field that is now at the
top of the card while the button is at the bottom of it. It says the same thing
in the one place it belongs, beside the button, where the ballot puts the same
kind of sentence — and it is now said to everybody rather than only to the
readers a poll happened to ask a name from.

That is also why the **Confirm options** button carries no count of its own,
only what pressing it will do: [turnout is reported in exactly one
place](#whether-respondents-are-shown), and a line under the button restating
the badge six inches above it would be the same fact arriving twice looking
like two. The sentence it does carry — *the poll opens for voting as soon as
everyone has confirmed* — is a rule rather than a number, it is the one thing
about the button that the button cannot show, and it is dropped once everyone
*has* confirmed, since a poll that stayed put there is one this line cannot
explain and must not promise.

**A confirmation announces itself as loudly as a vote**, and the one that opens
the poll announces twice: once for the roster moving, once for the option list
becoming a ballot. Both are worth hearing, and `16_live_update_signals` asserts
both counts — a page told nothing would be offering a box to suggest options to
a poll that had started taking votes.

**The poll opening is also an email**, and the last confirmation is what sends
it: everybody in the poll is told that voting has started, the creator
included, because the poll opened without them touching it. Pressing **Open
poll** instead sends the same letter to everybody but the creator, who pressed
it — see [What a poll writes to
people](#what-a-poll-writes-to-people).

**What the button does not do is un-confirm anybody else.** There is no
"the list changed, please look again" round trip, and adding that would be a
poll that can never open: every confirmation would invite one more suggestion.

### The creator can correct the options until somebody votes

Separate from where the options came from, and deliberately blind to it: a
poll's creator can add and remove options for as long as the poll has **no
ballots in it**. Before that existed, a typo in an option was permanent the
moment the ballot was — the fix was to duplicate the poll and send a new link
out, which costs everyone who already had the old one.

The window is exactly "no ballots", and nothing else enters into it. Not
`solicit_options`, which says where the list came from and is frozen either
way; not `options_finalized_at`, which is a stage. What the option list
promises is that **everyone who votes scores the same list**, and a poll
nobody has voted in has nobody who has scored anything — so changing it there
changes no answer anybody has given. `reset_poll` reopens the window, on the
same reasoning: everyone is being asked to vote again regardless.

`guard_options_frozen` has always drawn that line and still does, on every
write to `candidates` from any path at all. What `0028` added on top:

- **`creator_add_option()`**, because `authenticated` has no `INSERT` grant on
  `candidates` and `suggest_option` only serves a poll that is still
  collecting. Removing one needed nothing new: the `candidates_delete` policy
  already allowed the creator and the trigger already bounded it.
- **`insert_option()`**, the field rules for one option — name, description,
  duplicates, the 50-option ceiling — lifted out of `add_suggested_option` so
  both ways in apply exactly the same ones. Granted to nobody: both callers
  are `SECURITY DEFINER` and reach it having already decided this caller may
  write to this poll.
- **The two-option floor, on the delete.** A list still being collected may be
  pruned to nothing, because `finalize_options` applies the floor when it
  becomes a ballot; a list that already *is* a ballot has no later checkpoint,
  so the floor is applied to the delete itself. Otherwise correcting an option
  list could leave a live poll with one option and no election in it.

The creator reaches it from **Edit options** in `CreatorControls`, and it
replaces the ballot while it is open — they are two readings of one list, and
a poll with no votes in it has no ballot anybody is part-way through. A vote
arriving while it is open closes it and puts the ballot back.

**The button outlives the window it opens.** It used to disappear the moment
the first vote landed, on a page that otherwise looked exactly as it had a
second earlier, so the only thing a creator could learn from it was that
something they had just been able to do was gone — and nothing said whether
that was the rule or a bug. It now stays for as long as the poll has a ballot
and has not closed, and on a poll with votes in it opens a modal that says
what the rule is and offers the two ways round it: **Clear votes**, which
reopens the list on this same poll and its same link, and **Duplicate**, which
starts a fresh poll with the options you want and leaves this one alone. Both
are buttons in that modal rather than instructions to go and find them — they
live in the same block the modal is covering.

Closing the poll does take the button away, and that is not the same problem:
a poll that closes rewrites this whole block and the page under it at once, so
nothing about it vanishes quietly.

**What it does not promise is that nobody is looking at the old list.**
Someone with the ballot already on screen picks the correction up when the
change is announced, and a submit inside that window is refused rather than
filed:
`submit_ballot` and `open_poll_submit` both demand a score for every option,
and both reject an id that is not on the poll — so a stale ballot fails
whether the list got longer, got shorter, or had one option swapped for
another at the same length. Being told to try again is the safe half of that
trade; the unsafe half would be a ballot silently scoring an option nobody
showed the voter.

### Changing your vote until the results are out

A ballot used to be final the second it was cast. Nothing about this app
needed it to be: while the results are still sealed nobody has learned
anything from anybody's vote, so a voter changing their mind steers nothing
and is worth what it costs them to click twice. **Change my vote** sits on the
card you come back to after voting, on both kinds of poll.

**The window is "the results are not out". It is not "the poll is still
open",** and that difference is the whole design rather than a quibble about
wording. An invite poll reveals itself the moment its last invitee votes, with
nobody closing anything — see [Who can vote](#who-can-vote) — so a window
phrased on `closed_at` would be wide open on a poll whose tally, ranking and
winner are already on screen for everyone in it. Every voter could then go
back and re-score against the result. That is the one thing a revision must
never be able to do, and it is the only way this feature could have harmed an
election that the old rule protected.

It is also not a new line. `guard_invitee_changes` has always drawn it in this
exact place — an invitee may be added until the results are out, not until the
poll is closed — so the two features now rest on one rule rather than two that
agree by coincidence. `0032` writes that rule down once, as
`poll_results_revealed(polls)`, taking a poll row the way `poll_expires_at()`
does. `revise_ballot` and `open_poll_revise` refuse on it; `poll_status` and
`open_poll_view` — which is where the screen offering the button learns
whether the results are out — now answer from it instead of from their own
copy; and so does `assert_results_readable`, the gate `0031` had just lifted
out of the four callers that were each repeating it. That is the same argument
carried one function further: the rule it was lifted out of is the rule this
feature needs, so the results opening and the revisions closing are one event
rather than two that coincide. Two copies that agree today are a button that
offers something the database will refuse tomorrow.

`open_results_poll_id` is deliberately left out of it. Its body is not a copy
of this rule but two independent conditions in a chosen order, each with its
own message, and on an open poll the compound half of the rule — the
completion that unlocks an invite poll — is not reachable at all.

The cost is worth stating plainly: **on an invite poll the window shuts for
everyone the instant the last invitee votes**, so the person who votes last
never gets one. There is no way to give them one that does not hand somebody a
tally to score against, and the wait card says "until everyone invited has
voted" rather than "until voting closes" precisely so it is not making a
promise it breaks for whoever is last through the door.

**A vote is replaced and never withdrawn.** Every revision is an `update` of
the scores already on the ballot; the ballot row itself never moves. So
turnout does not change, an invite poll cannot be pushed back below the
completion that revealed it, and `is_complete`, the respondent roster and the
invitee guards see nothing at all. A delete would undo a reveal, and a reveal
in this app is one-way — [Settled polls](#settled-polls) caches a finished
poll's tally for the life of the tab on exactly that promise. There is no
"take my vote back" button and there is deliberately no function behind one.

**Nothing broadcasts, and that is the finding rather than an omission.** Every
trigger in [Live updates](#live-updates) exists because something on
somebody's screen went stale. Nothing here does: what a watcher can see before
the reveal is the turnout, the completion and the roster of who has answered,
all read off `ballots` rows that an `update` does not move — and everything
derived from `scores` is behind the reveal, past which no revision can happen.
A signal would wake every subscriber to re-read a poll and hand each of them
the answer they already had, which is the cost that section is written to
avoid rather than a freshness it is written to buy. There is still no trigger
on `scores`, and `ballots` still has triggers on `INSERT` and `DELETE` only.

Two conditions hold that up, and both are enforced rather than assumed:

- **A revision changes scores and nothing else.** In particular
  `open_poll_revise` does not take a name. A name on an open poll is on the
  roster other people are already reading, so changing it would be the one
  part of a revision somebody else could see — and a name quietly becoming a
  different name mid-poll reads as another person voting rather than as the
  same person having second thoughts.
- **It updates in place and never deletes and re-inserts the ballot.** The
  lazy version is invisible at the RPC boundary and would fire
  `ballots_broadcast_delete` and then `ballots_broadcast_insert`: two spurious
  signals for the no-op this is careful not to send, a new ballot id, and a
  moment in which withdrawal is representable.

`replace_scores()` is the scoring half, shared by both paths the way
`ballot_sheet()` is shared by the two ways of reading a poll's ballots.
It checks what `submit_ballot` checks and one thing more: that the payload
names each option **once**. That check does no work on an insert-only path and
real work here — a ballot sent two scores for one option would keep its old
score on another and go in looking complete, which is a half-rewritten ballot
rather than a rejected one.

Reading your own ballot back is two different cheap things rather than one
uniform one. An open poll's arrives inside `open_poll_view` as `your_scores`,
reached with the same `voter_key` that had to be held to cast it, so the panel
already has it and changing a vote costs no request until there is a changed
vote to send. An invite poll's comes from `poll_ballot_scores()`, asked for
only when somebody presses the button, because almost nobody does and a poll
page should still cost what it always did to open. `authenticated` has no read
of `scores` anywhere, which is why that is a function at all.

**The open-poll trade is the one this feature actually costs.** `voter_key`
was a dedupe token: holding it proved nothing except that this browser had
voted, and `src/lib/voterKey.ts` says as much. It is now also what hands a
ballot back, so on a shared browser the next person sees the previous one's
scores filled in where they used to see "your vote is in". The key is
per-poll, in that browser's `localStorage`, and never leaves it; open polls
already promise less than invite polls do, and this is inside what they
promise rather than a new hole in it.

### The order the options come in

Every ballot shuffles its options, and shuffles them the same way for any one
browser every time it is opened. `src/lib/ballotOrder.ts` holds it, and
`BallotCard` — the one ballot both kinds of poll are scored on — is the only
thing that uses it.

Ballot order is not neutral. An option at the top of a list is read first and
read most carefully, and scores better for it than the same option would
halfway down, so a poll that shows every voter one fixed list hands whatever
its creator happened to type first an advantage that has nothing to do with
the option. Shuffling per browser does not remove that advantage; it stops it
always landing on the same option.

Per browser rather than per render is what keeps it usable. A voter who
reloads, or who comes back to change their vote, finds the ballot where they
left it — and a list that reshuffled on every paint would be fair by exactly
the same argument and impossible to fill in.

What is stored is a single seed in `localStorage`, not the running order of
any one poll. The order is derived by hashing that seed with each option's id,
so nothing has to be invalidated when the list moves: a creator correcting the
options, or a soliciting poll taking one more suggestion, slots the new option
into the order the rest already have. One seed also covers every poll on its
own, because option ids are unique to their poll — the same browser gets an
unrelated order in the next poll without needing a key per poll to remember it
by. Storage that refuses falls back to a per-tab seed, as `voterKey.ts` does.

The hash is FNV-1a finished with murmur3's avalanche step, and the finisher
earns its keep. Every option is hashed as the same seed followed by a
different id, and FNV alone leaves two such hashes differing by close to a
fixed XOR pattern — enough to sort with, but not evenly, because comparing
XOR-related numbers favours whichever id carries that pattern in its high
bits, in the same direction for every browser. Measured over 200k seeds on a
five-option poll, plain FNV put one option first 24% of the time and another
17%, against the 20% each the shuffle exists to deliver; with the avalanche
the same measurement comes back inside 19.8–20.2%.

It is display only. A ballot is sent as a score per option id and read back by
id — `submit_ballot` checks the length of the list and then looks up every
`candidate_id` in it — so the order it travels in means nothing to anyone.
`BallotCard` is the only caller, which is the same statement as before it was
extracted: there is one ballot on screen and it is shuffled, whichever kind of
poll's RPC the scores end up going to. Nothing else in the app is shuffled: results are ordered by score, the
published ballot sheet has an ordering of its own that is deliberately not
arrival order, and the creator's option editor shows the list in the order
they typed it, which is the thing being edited.

### Scoring an option

The stars on a ballot are `src/components/StarRating.tsx`, not Mantine's
`Rating`, and the difference is entirely about phones. Mantine's control sets
the score from `touchstart`, working out which star was meant from the
finger's x coordinate against the row's bounding box, and then the click the
browser synthesises afterwards applies the tap a second time — a click
Mantine tries to swallow with a `preventDefault` in `touchend`, which
browsers honour unevenly. On a touch screen that produced two things nobody
could reproduce on a desktop, both reported as *scoring one option changed
another*:

- A finger that lands on a star row only to **scroll** scores that option on
  the way past. Scrolling down the ballot to reach option 2 could therefore
  rewrite option 1 — and since pressing the star that is already picked
  clears an option back to 0, landing on it wiped that score outright.
- Where the synthesised click is not swallowed, the same tap both sets the
  score and, running into the clear again, takes it back to 0.

So the ballot draws its own stars: a button per score, one event path
(`click`), and no coordinate arithmetic — a star says which score it is. A
swipe that starts on the stars scrolls the page and changes nothing. The
buttons carry padding around the star so the target is bigger than the 20px
it draws, which is the other half of being right on a phone, and the group is
a radio group to a screen reader — one tab stop, arrow keys between the
scores.

0 is a real score rather than the absence of one, and pressing the star
already picked is the only way back to it, which is what the line above the
options tells the voter.

### What a form checks before it sends

Every form in the app used to fail the same way: one red line, in one place,
naming the first thing that was wrong. On the create form that place is under
the submit button — the furthest point on the page from most of the answers —
so *Add at least two options* left the reader to go and find which two, and
fixing it earned them the next message rather than the poll.

Errors now sit on the field they belong to, as Mantine's error state, and
every rule is checked in one pass so all of them appear at once. When they
appear is the other half of it: **on the first submit, and cleared as each
field is corrected**. A field that goes red while you are still typing in it
is telling you off for being halfway through, and one that stays red after
you have fixed it is worse. `CreatePoll` does this by computing the whole
error set on every render and showing it only once `showErrors` is set, which
is also why fixing a field needs no second press.

`src/lib/limits.ts` holds every length in one place, and three of them are
not the form's own idea. `add_suggested_option` has capped a suggested option
at 100 characters, its description at 500, and a poll at 50 options since
options could be suggested at all — limits written for the one field a whole
group can write to, but they answer the same question the create form asks:
how long is a label on a ballot, and how long is the note under it. The form
applies them so that two paths into `candidates` cannot disagree about what
fits. The duplicate-name check is the same story: `add_suggested_option`
refuses a name already on the list, case-insensitively, because two options
differing only in case are one option to everybody scoring the ballot. The
create form now refuses the pair too, marking the *later* row — the earlier
one keeps the name, so it is not the one that has to change.

A title and a poll's description are bounded by the form alone; nothing in
the database bounds either, and neither limit is a security measure.

None of this is trusted and none of it is relied on. **The database is still
what decides**, and anything it refuses for a reason not listed here comes
back the way it always did — as the error under the form. What the checks buy
is being told which box is wrong instead of being told no.

### Creator controls

On the poll page, the creator gets a **Manage poll** block holding everything
they do to the *poll*:

- **Open poll** — on a poll collecting its options, and only there: finalizes
  the list and lets people vote. One-way. Disabled until the list has the two
  options an election needs, with the reason on a tooltip.
- **Edit options** — on any poll that has a ballot and has not closed. With no
  votes in it, it swaps the ballot for the option list so it can be corrected;
  with votes in it, it says why it can't and offers the two things that do
  work. The way back out of the editor is **Done**, under the list itself, and
  this button is not offered while that list is up: finishing with something
  belongs beside the thing, not in a block further down the page. See [The
  creator can correct the options until somebody
  votes](#the-creator-can-correct-the-options-until-somebody-votes).
- **Close voting** — reveals results using the votes cast so far. One-way.
- **Duplicate** — opens the create form prefilled from this poll (options,
  invitees, all four settings). Nothing is created until submit, so the copy
  can be edited first, and the original is untouched.
- **Reset votes** — deletes every vote and reopens the poll, keeping its id,
  options, invitee list and link. Anyone who already voted can vote again,
  and they aren't told the poll was reset.
- **Delete poll** — removes the poll and every vote cast, permanently.

Open, close, reset and delete all confirm in a modal first, and **the modal is
where what the button will do is spelled out** — none of them carries a
paragraph of explanation out beside it. A block of six buttons each with its
own sentence is a block nobody reads, and the sentence that matters is the one
in front of you at the moment you are deciding, not the one you scrolled past
on the way to the button.

The **share link** sits in the same block (`src/components/ShareLink.tsx`),
with **Copy** and a **QR code** beside it. Handing the poll out is something
the creator does to the poll, not something a voter needs while scoring
options, and keeping it here means it is never withheld — the link has to go
out before anyone, the creator included, has voted. Open polls also offer it on
the thank-you card once you have voted, where passing it on is a reasonable
thing to want.

**The label and the caption span the row, not the box.** They were the text
field's own `label` and `description` once, which put them inside a field
sharing a no-wrap row with two buttons: the field is the part of that row that
gives, so on a phone it was squeezed to a few words wide and the caption — a
full sentence — unspooled down the column. Nothing in the caption was ever
only about the box, either. *Anyone with this link can vote without signing
in* is as true of the link **Copy** lifts and of the one the QR code carries;
the three are one control for handing the poll out, and the sentence is about
the link rather than about the widget it happens to be printed in. So an
`Input.Wrapper` holds the whole row, the label still reaches the box through
`htmlFor` — hence the generated id, since this renders on the creator's page
and inside the open-poll panel alike — and the sentence gets the width it was
written for.

### A poll can ask more than one question

A multi-question poll is **several ordinary polls that know they belong
together**. `group_id` says which set a poll is part of, `question_position`
says where in it, and `question_title` is what that one question asks; the
poll's own `title`, description, mode and settings are the same on every row.
All three columns move together or not at all (`polls_question_ck`), and like
every other poll setting they are frozen at creation — `authenticated` still
has no `UPDATE` grant on the table.

**Nothing about the election changed.** `poll_tally`, `star_round` and
`poll_ranking` take a poll id and count the ballots against it; a question is
a poll, so they were not touched, and neither were their tests. That is the
whole reason for this shape rather than a `questions` table under `polls`,
which would have moved two foreign keys and rewritten every one of those
functions to reach a poll through one more hop, for no difference in what a
voter sees.

Three things are true of the set rather than of one question, and each is one
existing rule widened rather than a second rule to keep in step:

1. **One invitation.** Every question carries the whole invite list, because
   that list is what the row-level security on its options and ballots reads.
   `trg_send_invite_email` therefore fires for the first question only —
   through a `WHEN` clause calling `poll_is_first_question`, so the trigger
   holds the rule about who gets told and the function stays about the letter.
   A five-question poll sends one email per person, and it links to question 1.
2. **One reveal.** `poll_results_revealed()` was already the single place
   deciding whether a poll has shown its tally; `poll_status`, `open_poll_view`,
   `assert_results_readable` and both revision paths all read it. It now asks
   the *gate* of every question in the group, so question 1's result cannot be
   read while question 5 is still taking votes — the same promise a
   single-question poll makes, applied to the unit the voter thinks in.
   **"Has anyone answered" stays per question**, so a poll closed with nobody
   having reached question 5 still shows question 1's result, and question 5
   says it took no votes.
3. **One lifecycle.** `close_poll` and `reset_poll` walk the group, and the
   Delete button removes every question. The creator acts on the poll, not on
   the question they happen to be looking at.

**Ballots, voter keys and voter names stay per question**, and this is the
part most likely to look like an oversight. A voter gets one ballot and one
`voter_key` per question, because `voterKeyFor()` is scoped to one poll — and
a question is a poll — which is what stops one browser's ballots being joined
to each other; see `src/lib/voterKey.ts`. The continuity a voter actually
notices is the name, and that lives in the browser instead
(`src/lib/voterName.ts`): typed once, offered back on the next question,
never linked on the server. `open_poll_group` accordingly returns the sibling
ids and **no "answered" flag**; `poll_group` does return one, because an
invite ballot carries an account and nothing has to be linked to find it.

**The tick a voter is owed comes from the browser, for the same reason the
name does.** That rule about `open_poll_group` is a rule about *the server*,
and it was read for a while as a rule about the reader: `answered` arrived
undefined on every open poll, so the question strip marked nothing on the
public route — and nothing on the creator's own page either, since
`poll_group` matches ballots on `voter_id` and an open poll's carry no
account. A voter who had answered three of five questions was shown a strip
that said they had answered none, which is not the promise being kept, it is
the promise being kept against the one person it was never about.
`open_poll_group`'s own comment already said where the answer lives — *the
browser already knows which questions it has answered; it is the one place
entitled to* — so `src/lib/questionMarks.ts` is that place, alongside the
remembered name and read the same way: written on a ballot going in, never
sent anywhere, and load-bearing for nothing. Being wrong about it colours a
badge. It cannot let anybody vote twice, read a sealed result, or reach a poll
they hold no link to; the server decides all three from the key it is shown,
on every call.

**It holds two marks now, and they are the same mark one stage apart.** The
strip marks the question a reader has finished with, and while the poll is
still collecting its options that is the confirmation rather than the ballot —
so `poll_group` answers both on the invite side (`0042` adds the second) and
the browser answers both on the open side, where a confirmation is identified
by the same per-question key a ballot is and is just as deliberately
unlinkable. They are stored under separate keys because they are true at
different times: a poll still collecting takes no ballots and a poll taking
ballots collects nothing, so one key holding both would mean a question
confirmed before the poll opened reading afterwards as a ballot nobody cast.

A record is **erased as well as written**: a creator who clears the poll's
votes leaves a browser holding a ballot that no longer exists, and a
confirmation can be taken back on the card that gave it, so a read that comes
back *not voted* — or *not confirmed* — takes the record with it rather than
letting a stale tick outlive it. Both are keyed by poll id, which is all a
question has — the answered mark used to take two entries, the share token the
public route knew a question by and the poll id the creator's page knew it by,
and it does not any more for the same reason those two pages are now one
address.

What this costs, knowingly: nobody can tell whether the six people who
answered question 2 are among the eight who answered question 1. That is an
aggregate over other people on an anonymous poll, which is exactly the
correlation the key scoping exists to prevent, so losing it is the feature
working rather than a gap.

**Collecting options is one stage for the whole poll.** Each question gathers
its own list, because a suggestion lands in `candidates` against a poll id and
that is what a question is — so `suggest_option` and friends never changed.
But `finalize_options` opens every question at once, for the same reason
closing does: a poll half-opened would take votes on some questions while
others were still gathering.

The floor of two options is therefore checked against **every** question
before **any** is opened, and the refusal names the question that is short —
on a poll of five, "add two options" leaves the creator to work out which one.
The creator's *Open poll* button applies the same rule from the option counts
`poll_group` returns, so it is disabled with the reason rather than offered
and turned down. A poll asking one question has no name to give and raises
exactly the message it always did.

**Writing one.** `CreatePoll` holds a list of `QuestionDraft`s whether or not
the poll asks more than one — a single-question poll is one entry whose title
is never read — so every rule about an option list is written once and applied
to every list there is. Turning the switch on puts that list behind a strip of
tabs, one per question. Laid out all at once it was a form that grew with the
poll: five questions of five options each is fifty fields in one scroll, with
no way to see the shape of what is being asked and no way back from question
four to question one except past everything in between. The tabs are also the
shape the poll wears once it exists — `QuestionStrip`, on the voting side — so
a creator lays the poll out the way their voters will walk through it.

Three things keep the tabs from hiding anything:

- **A `+` is the last tab**, rather than a button under the strip. Adding a
  question *is* adding a tab, and the strip is where a reader already looks to
  see how many there are. It is never the selected tab: the open tab is only
  ever a question's key, so pressing `+` makes a question and opens that
  instead. One `onChange` handles both, telling them apart by a sentinel value
  no question key can collide with.
- **Removing a question does not live in the strip, and is named rather than
  drawn.** It sits at the foot of the question it removes, opposite *Add
  option*. It was a bare red `×` beside the title field before, which put the
  control that discards a whole question — its title, its options, their
  descriptions — inside the row for editing that question's *title*, where the
  nearest reading of it was "clear this field"; and it sat a few pixels from
  the option rows' own `×`, which discards one line. Two buttons that destroy
  different amounts should not look alike and should not sit together. The
  asymmetry with `+` is real and is the lesser cost: a remove control in the
  strip is either a button nested inside a tab's button, or a tab that is not
  a question. What the two controls actually share is not a row — it is that
  each sits beside what it acts on, `+` beside the tabs it adds to and this
  beside the question it ends. **Two questions is the floor**, since below it
  the poll asks one, which is what the *Multiple questions* switch is for
  rather than something to arrive at by removing the second.
- **Every question is validated on every submit**, on screen or not; the tabs
  changed what is rendered, not what is checked.
- **A tab whose question has something wrong with it is marked**, and a submit
  that fails opens the first of them. Validating a question nobody can see is
  only worth doing if the reader is told where to look, and "press Create,
  watch nothing happen" is what the mark and the jump exist to prevent.
- **A question is identified by a key rather than by its position.** Removing
  question 2 of four slides 3 and 4 down one, and a tab holding the number
  would quietly be looking at a different question afterwards. The key never
  leaves the form: `create_poll_group` takes the questions in order.

**On screen.** The poll list shows position 1 and hides the rest
(`list_polls`), with the count badge reading *N questions* instead of a
turnout — the turnouts come apart the moment somebody answers three of five,
and the first question's number would read like the whole. Its state badge
stays *Results ready* rather than naming a winner, because there is one per
question; the winner is named on each question's own page. `QuestionStrip`
carries the walking between them, and renders nothing at all below two
questions, so every existing poll looks exactly as it did.

**Answering a question opens the next one owed.** There was a card at the foot
of the page offering to — *Next question: …*, with a button — and it was one
press and a scroll standing between a voter and the thing they had already
decided to do. A voter working through five questions wants the sixth screen to
be question 2, every time; asking them five times is four presses that answer a
question nobody was asking. So the card is gone and the page moves by itself, on
three conditions, each of which is a case where moving would be wrong:

- **A first ballot only.** Changing a vote is a deliberate trip back to a
  question already behind you, and carrying you forward again undoes the trip
  you just made. `OpenPollPanel` takes `onFirstVote` separately from
  `onChanged` for exactly this, and the revision path never calls it.
- **To a question still outstanding**, which is not the same as the next one
  along — `nextUnansweredKey` in `src/lib/nextQuestion.ts` decides. The two
  agree for anybody working a poll front to back, which is nearly everybody;
  they come apart for the voter who jumped into the middle from the strip, and
  for them "the next one" is a ballot already cast. **The search rounds**:
  forward from the question just answered, then wrapping to the ones before
  it, so a voter who started at question 3 is taken back to question 1 rather
  than stranded on the last question with two unanswered ones behind them. The
  card that used to offer the way on is gone, so stopping at the end would be
  a dead end — the strip says what is outstanding but does not act.
- **Only while something is owed.** Every other question answered leaves the
  voter where they are, and the page does what a single-question poll always
  has: re-reads itself into *your vote is in*.

The list it chooses from is the list the strip is drawn from — both pages build
it once and pass it to both — so a voter is only ever carried to a question the
strip in front of them shows as outstanding. That is a construction rather than
a promise the two have to keep separately. The question just answered is
excluded by key rather than by its flag, because the choice is made as the
ballot goes in and no read has yet come back to say so.

Advancing replaces the re-read rather than joining it. The page being left is
left at once, and a read of the question being left would land after the next
question had loaded.

**A crossing between two questions replaces the question, not the poll.** A
question is a poll of its own at an address of its own, so moving between two
of them changes the route's *parameter* and not the route, and React keeps the
page mounted across that with everything it was holding. Two opposite mistakes
are available here and the first draft of this made the second one:

- **Keep it all** and the question being left goes on rendering under the
  address of the question being opened — the previous question's options, or
  its *your vote is in*, beneath the next question's title, for as long as the
  read takes. That is what the page did before auto-advance, and auto-advance
  turned it from something you saw on the occasional *Next* click into
  something you saw on every vote.
- **Throw it all away** — by keying the route on its parameter, so the
  crossing is a mount — and the question strip goes with it, blinking out and
  back at the exact moment a reader is using it to navigate. Measurably: two
  frames, one of them a bare page with no strip at all.

Neither is necessary, because the page is two things and only one of them
changes. **The poll's own half — the heading, its terms, the strip — is the
same for every question in the group**, so it stays on screen. **The
question's half — what it asks and the ballot answering it — is replaced**,
and shows `QuestionSkeleton` until the read for *this* question lands.

Each page draws the line with one value. `PublicPoll` holds its read as
`{ pollId, view }` rather than a bare view, so `view` is that pair only when
the id matches the address and `shell` falls back to the last read of a
*sibling* question — established by the strip's own list holding both ids.
`PollDetail` keeps `loadedFor` beside its state and gates on `showing`. Both
fall back to the whole-page skeleton when the address names a poll they hold
no group for, which is a page load rather than a crossing. `open_poll_group`
answers the same list for every question in a group, so crossing between them
also costs no request at all.

### Telling people the results are ready

An invitation was the only thing this app ever emailed, which meant it
announced the one moment nobody was waiting for and stayed silent through the
one everybody was. A poll's results unlock on their own — when the last invitee
votes, or when the creator closes it — and the only way to find out used to be
to keep opening the poll. The people most likely to miss it are the ones who
voted early, which is to say the ones who cared enough to answer first.
`notify_results_ready` and the four triggers that call it, in the squashed
baseline under [`supabase/migrations/`](supabase/migrations), are the whole of
it.

The delivery half is the invitation's, deliberately: `pg_net` posting to
Resend with the key read from Vault at send time, best-effort, never blocking
or failing whatever triggered it — see [Emails](#4-emails). What is new is that
this is a **transition** rather than an insert, and a transition has to be
noticed exactly once.

- **Once per poll, not once per question.** A group's questions unlock
  together, so five questions are one result and one email, pointing at
  question 1 — the same rule and the same landing place as the invitation.

- **The claim is a row, not a column.** `results_notices` holds one row per
  poll that has been announced, and its primary key *is* the once-only rule:
  two ballots landing in the same instant both try to insert it, one wins, one
  email goes. A column on `polls` would have done the same job and would also
  have widened every `select *` the app makes and woken every watcher of the
  poll a second time, for bookkeeping nothing on screen reads. The table has no
  grants and RLS on with no policies; only the `SECURITY DEFINER` functions
  that maintain it can see it.

- **A reset takes the notice back.** Reset deletes every vote and reopens the
  poll, which can then finish again with a different answer; that is a second
  result, and the people in it are told about it. So anything that puts a poll
  back to taking votes drops its notice row, and being announced is a property
  of the poll *being* finished rather than of it having once been finished.

- **`poll_results_ready()` is not `poll_results_revealed()`**, and the
  difference is the one that matters to an inbox. The latter answers about one
  question: *this* question has taken a ballot, and every question in its group
  has stopped. A poll closed before anybody reached question 5 has results for
  question 1 and none for question 5 — right on the page, wrong in an email,
  where there is one result and it is the poll's. So the ballot test is asked
  of the group: at least one ballot somewhere in it, and every question's gate
  open.

- **Every invitee is told**, deduplicated and lowercased, and not just the ones
  who voted: an invitee who did not vote is still in the poll — it finished
  around them, and the result is a decision they are subject to.

- **The creator is told only if the poll finished on its own.** A poll ends one
  of two ways: the last invitee votes, or somebody closes it — and only the
  creator can close it. Telling them the news they just made themselves is an
  email whose entire content they already have, so `closed_at` is the test:
  set means closed by hand, and the creator comes off the list — as an invitee
  too, on a poll they invited themselves to, since the reason they need no
  email does not stop applying because they are also on the invite list. That
  rule outgrew this email — see [What a poll writes to
  people](#what-a-poll-writes-to-people) — so `poll_results_audience` now
  says it in terms of `poll_email_audience`, which is the same sentence with
  "finished on its own" left to the caller. An
  open poll only ever ends by being closed, so its audience is empty and it
  sends nothing at all: its voters gave no addresses, and the one person it
  could have written to is the person who closed it.

- **One request per address.** Resend would take the whole list in one `to`,
  and that would show every invitee every other invitee's address — precisely
  what a poll with respondents hidden promises not to do. The fan-out is the
  price of the promise.

- **The email does not name the winner.** A poll of several questions has one
  winner per question and no single one to name; an email cannot be un-read by
  somebody who wanted to see the tally first; and the link is one tap from the
  answer either way.

`notify_results_ready()` is the whole rule in one function, called from four
triggers — a ballot arriving, a ballot leaving, an invitee leaving, and
`closed_at` moving — and idempotent by construction, so none of them has to
know what the others have done. It re-derives whether the poll has a result and
reconciles the notice row with that answer; called on a poll nothing has
changed about, it does nothing. Nothing is needed for an invitee *arriving*,
because `guard_invitee_changes` already refuses to widen the list of a poll
whose results are out.

The claim comes before the send, so a mailer that is not configured leaves a
notice row with no email behind it — the same bargain the invitation makes.
Releasing the claim on a failed send was the alternative, and it would turn
every transient Resend outage into a duplicate on the next vote.

`test/sql/cases/21_results_ready_notices.sql` covers everything but the send
itself: whether a poll has a result, who would be told for each of the two ways
a poll can end, that the notice appears exactly once when the poll crosses the
line, that a reset takes it back and a second finish announces again, and that
a group is one notice filed against question 1.

### What a poll writes to people

The results email came second, and by arriving it showed what was wrong with
the first one. An invitation is worded for a poll you can vote in, and it is
sent when the poll is created — which on a poll that collects its options is
the one stage where there is nothing to vote on. It also went to the creator,
who wrote it. So a poll had four moments in it and wrote about one and a half
of them, in a letter whose subject line — *You're invited to vote* — is how
bulk mail opens, which is how Gmail read it.
[`0043_the_emails_a_poll_sends.sql`](supabase/migrations/0043_the_emails_a_poll_sends.sql)
is the four letters and the two rules that decide them.

- **The invitation says which stage the poll is at**, because that is what
  the person reading it can act on. `poll_invite_kind` answers `options`
  while the poll is still collecting them and `vote` once there is a ballot,
  and it reads the poll at the moment the address is added — so somebody
  invited to a soliciting poll on Monday is asked for options, and somebody
  added to the same poll after it opens is asked for a vote.

- **Nobody is told what they just did.** The creator set the poll up, so an
  invitation is `none` for them — including on a poll they invited themselves
  to, which the create form offers with a checkbox, since the reason they
  need no email does not stop applying because they ticked a box. The same
  rule decides the other two: a poll opened with the creator's own Open poll
  button, or closed with their own Close button, is not news to them; a poll
  that opens itself because the last invitee confirmed, or finishes because
  the last invitee voted, is news to everybody in it.

- **The rule is one function, and the caller supplies the answer.**
  `poll_email_audience(poll, include_creator)` is every invitee plus the
  creator, deduplicated and lowercased, minus the creator when the flag says
  they already know; `poll_results_audience` is that with `closed_at is null`
  passed in, and `notify_poll_opened` takes the flag from which of the two
  openers called it. Nothing on the poll row records *how* it opened, and
  adding a column to record it would widen every `select *` the app makes for
  bookkeeping nothing on screen reads — the same argument that made the
  results notice a row of its own. What the two callers know, they say.

- **Opening needs no notice row, and finishing does.** `options_finalized_at`
  is written once and nothing puts it back — a reset reopens voting, not the
  option list — so the two functions that open a poll are the two openings
  there are, and each writes once. `open_options_when_all_confirmed` still
  has to check: it runs inside every confirmation and every invitee removal
  on a soliciting poll, so it announces only where its update actually opened
  something, and a second call after the poll is open writes to nobody.

- **One letterhead, one mailer.** `poll_email_html` is the card — a heading, a
  sentence, a button and the link under it — and `send_poll_email` is the only
  place this app talks to Resend: it reads the key from Vault, builds the
  link, and returns quietly where there is no mailer. Four copies of a table
  layout would have been four places for a padding value to drift. The
  fan-out is per address for the reason it always was: one request with every
  invitee in the `to` would show each of them all the others, which is what a
  poll with its respondents hidden promises not to do.

- **Subjects name the letter; they do not sell it.** All four are the same
  shape — *Your ballot for X*, *Help choose the options for X*, *Voting is
  open for X*, *Results are available for X* — which is both less like bulk
  mail and more use to somebody with three polls running. The bodies got the
  same treatment: the results email described the scores, the runoff and the
  full ranking to somebody one tap from all three, and now says that results
  are available and stops.

- **An open poll writes nothing at all**, and needs no special case to. It has
  no invite list, so there is nobody to invite; it never opens itself, so its
  opening is always its creator's own doing; and it only ever ends by being
  closed, by the one person who would have been told. Every audience it has
  is empty.

`test/sql/cases/23_who_the_emails_go_to.sql` covers both decisions and neither
send: which invitation each address is owed at each stage and that the creator
is owed none, and who is in the audience for a poll opened by hand against one
that opened itself. The sending is untestable here for the reason it always
was — there is no `pg_net` in the throwaway database — so the suite can say
who *would* have been written to and never that anybody was.

### Polls are deleted after six months

Nothing in this app had ever removed a poll it was not told to remove, so
every poll ever created was still in the database and the storage bill only
went one way. The app is free and promises nobody a permanent record; what it
does promise instead is a rule that is written down, applied to every poll
alike, and visible on the poll itself before it comes due.
The schema half of it is in the squashed baseline and the scheduling half in
[`supabase/after-squash.sql`](supabase/after-squash.sql):

- `poll_retention_window()` is the period, and the only place the number is
  written down. `poll_expires_at(polls)` is when one poll goes.
- **The clock runs from `created_at`, and nothing moves it** — not a vote,
  not the option list being settled, not the creator closing the poll. Dating
  it from the poll's last activity instead was written and then rejected: an
  open poll takes votes from anyone holding its link and nobody has to close
  it, so "six months since something happened" is a window one stray vote
  reopens and a forgotten poll never reaches — which is the exact poll this
  exists to clear out. Creation is a date every poll has, that nothing can
  move, and that its creator can read off the page on the day they make it.
  A poll that has to outlive its six months gets **Duplicate**, which the
  creator already has.
- `purge_old_polls()` deletes every expired poll and returns how many went. It
  deletes the `polls` row and nothing else: every table hanging off a poll is
  `ON DELETE CASCADE`, which is what the creator's own **Delete poll** button
  already relies on, so there is one definition of what deleting a poll means.
- **pg_cron runs it nightly**, as the job `purge-old-polls`. The extension
  only exists on a real Supabase project, so both the `create extension` and
  the `cron.schedule` sit in `DO` blocks that degrade to a notice. They live in
  [`supabase/after-squash.sql`](supabase/after-squash.sql) rather than in the
  baseline, because scheduling is not schema and a squash would drop it — see
  [Squashing](#squashing). The throwaway database `npm test` builds has no
  scheduler, but `test/sql/shim.sql` stands in a `cron` schema so the schedule
  lands somewhere a case can assert on.

If the job is ever missing on the live project — pg_cron not enabled when the
migration ran is the likely reason — enabling it and scheduling it is the
whole fix, and nothing else needs redeploying:

```sql
create extension if not exists pg_cron;
select cron.schedule('purge-old-polls', '17 4 * * *', 'select public.purge_old_polls()');
```

`select * from cron.job_run_details order by start_time desc limit 10;` says
whether it has been running, and `select purge_old_polls();` runs it by hand.

The date reaches the app as `expires_at` on `poll_status()` — which the poll
page already asks for on every live read — rather than as a column on the
`polls` select. The app deploys on push and its migrations apply on merge, so a
browser can be a few minutes ahead of the database: an extra RPC column it
does not know about is `undefined` and says nothing, where a select naming a
column that does not exist yet fails outright and takes the poll page with it.

`RetentionNote` (`src/components/RetentionNote.tsx`) is the line at the foot
of the poll page, **shown to the poll's creator and to nobody else**. It used
to be shown to everyone the poll admits, on the grounds that an invitee's
ballot goes on the same day — but a retention date is a thing to *act* on, and
the only act there is belongs to the creator: **Duplicate**, which nobody else
has a button for. For a respondent it was a deadline about somebody else's
poll with nothing on the other end of it, on a page they had come to in order
to vote or to read a result. The policy itself is still public, on the
[About](src/pages/About.tsx) page, which is where somebody who wants the rule
rather than this poll's date will look.

It is quiet for almost all of a poll's life and becomes an orange warning in
the last month, when there is still time to act on it — which is also when it
names Duplicate. An automatic deletion is only fair if it was never a surprise,
which is the whole reason the date is on the poll from the day it is created —
and why it is the same date on the last day as on the first.

The public voting page carries no date, and `open_poll_view` no field for
one: it answers to a link rather than to an account, and it is read once by
someone who came to vote. The policy is on the [About](src/pages/About.tsx)
page, which is public, and on the poll page its creator uses.

### The QR code

`ShareQr` (`src/components/ShareQr.tsx`) encodes the same link `ShareLink`
shows, for handing a poll to a room holding phones rather than keyboards. It
grants exactly what the link grants — on an open poll the code *is* the
capability, so putting one on a projector puts the poll in front of everyone
who can see the screen, and the modal says so.

Generated in the browser from `uqr`, the only runtime dependency added for it,
via `src/lib/qr.ts`. Four things there are fixed rather than left to the caller,
because each produces a code that looks right and scans badly:

- **Error correction M, not the default L.** L saves a few modules and gives up
  the tolerance that lets a code survive being printed, taped to a wall and
  photographed at an angle.
- **A four-module quiet zone.** The margin is part of the symbol — scanners use
  it to find the edge. uqr defaults to one module, below spec.
- **Black on white always, in both colour schemes.** A QR code has to be
  dark-on-light, so the modal puts it on its own white plate rather than
  inverting it in dark mode.
- **The PNG is drawn module-by-module on a canvas**, at a whole number of
  pixels each, rather than scaling the SVG. A module boundary landing on a half
  pixel gets anti-aliased to grey, and a blurred boundary is the one thing that
  reliably breaks a scan.

It is behind a button rather than inline: most polls are shared by pasting a
link, and a code big enough to scan is too big to sit in the manage block
unasked.

### Results and the full ranking

Results show the winner, every option's score-round total, any tie-break that
had to be resolved, and the automatic runoff between the two finalists. On a
poll that publishes its ballots, the grid of every ballot cast follows
underneath, with column totals to check the score round against, and the
participation card is last — it is where turnout is stated, and the results
no longer state it themselves (see [Whether respondents are
shown](#whether-respondents-are-shown)). The one thing they do still say
about the count is that voting was closed early, which is the one thing that
card cannot: it explains why the numbers are smaller than they were going to
be.

**See the full ranking** (on polls with more than two options) opens the whole
field in placed order. STAR itself only names a winner, so the rest comes from
running the method again on the options left standing: the winner steps out, the
two highest scorers remaining go to a runoff for the next place, and so on down
the list. Scores are absolute sums rather than transferable votes, so
eliminating an option never changes anyone else's total — the score order is
fixed, and each round is just the next runoff down it.

**It is a request of its own, made when the button is pressed.** The ladder
used to ride along inside `poll_tally`, which meant every reader of every
result paid for a round per option whether or not they ever opened the modal —
and that ladder is far and away the most expensive thing this app asks a
database for. Against the test database on random polls, each call in its own
transaction as it is in production, median of five after a warm-up:

| options | voters | one call (old) | winner only | the ladder |
| ------: | -----: | -------------: | ----------: | ---------: |
|       4 |     20 |        20.4 ms |      6.4 ms |    15.9 ms |
|      10 |    100 |        48.3 ms |      8.4 ms |    48.3 ms |
|      20 |    200 |       190.4 ms |     11.7 ms |   187.0 ms |
|      50 |    200 |       526.6 ms |     19.4 ms |  541.9 ms |

The ranking was 58% of the JSON on the smallest of those and 77% on the
largest. `poll_winner_name()` had already drawn this line for the poll list
— "a list row wants none of that" — and `0031` draws the same one for the
results page: `poll_tally` runs the head round and stops, and `poll_ranking`
is asked for separately by `FullRanking`.

Two things follow, and neither is free:

- **Opening the modal costs more than the old single call did**, not less.
  First place is part of the ranking, so `poll_ranking` runs the head round
  again rather than being handed it. The trade is 4–18% more for the readers
  who ask, against 69–96% less for the readers who don't — and the answer is
  cached like the tally is, so a reader pays it once per tab rather than once
  per opening. The overhead is worst in relative terms on the smallest polls,
  where one round is a large fraction of the work and the whole thing is over
  in milliseconds anyway.
- **The modal has a loading state now**, where it used to draw instantly from
  data already on screen. The button itself does not: whether it appears is
  decided by the option count the tally already carries, so it never waits on a
  request to find out whether it should exist.

**The gate is one function, not four.** `get_poll_ranking` and
`open_poll_ranking` answer on exactly the terms `get_poll_results` and
`open_poll_results` do, and they do it by calling the same
`assert_results_readable` / `open_results_poll_id` those two now call. The
ranking discloses *more* than the tally — every placing, every runoff below the
headline one — so it must not be readable on easier terms, and a visibility
rule written out four times is four places for it to drift.
`test/sql/cases/17_ranking_is_gated.sql` holds each refusal to both.

Two consequences, which the modal states rather than hides:

- **The runner-up of the headline runoff is often not second.** It still has to
  beat the third-highest scorer, and it can lose that. An option can lead on
  points and place third.
- **Most pairs of options never meet.** Ordering n options takes n−1 runoffs,
  out of n(n−1)/2 possible pairings — a ladder, not a round-robin. Where two
  options did face each other the loser is always placed below the winner, but
  that guarantee covers only those pairs. Elsewhere an option can be preferred
  to one placed above it, and it takes no Condorcet cycle for that to happen: an
  option scoring too low to reach the first runoff enters the ladder below
  options it would have beaten. Only first place is what STAR itself produces.

### Tie-breaks

Documented for readers on the `/about` page (`src/pages/About.tsx`) and
implemented in the migrations. A score-round tie goes to the option preferred by
more voters head-to-head, then to the one given five stars on the most ballots,
then randomly. A runoff tie goes to the higher total score, then to the
five-star count, and if the options are level on all three the election has no
winner — the app reports the tie rather than inventing a result. If you change a
rule, change the SQL, the About page and the cases in `test/sql/cases/`
together; they are a set.

**A head-to-head tie-break is reported as the comparisons it is made of**, not
as the score it keeps. The rule pairs every tied option with every other and
counts the pairs each one won, and for the commonest tie there is — two
options level on points, one runoff slot between them — that count is zero on
both sides whenever the pair itself is level. "0 matchups won" twice is a true
and unreadable statement of a tie, in a unit nobody outside voting theory uses,
at the moment a reader is working out why their option went out.

So `star_round` sends the pairs themselves (`steps[].matchups`: the two
options, the voters who preferred each, and the voters who scored them the
same), and `Results.tsx` renders a two-option tie as the single comparison it
is — "3 voters preferred each, 2 scored them equally", the words the runoff
below already uses for the same arithmetic, with the word *matchup* gone. A
group of three or more keeps the per-option totals, because there the totals
are the point (the rule is asking which option beat the most others), and
lists the pairs beneath them. The totals are derived from those same pair
rows, so the two can't disagree.

The counts ride along in the payload rather than being fetched when a reader
expands something: they are a few integers over a poll whose results that
reader is already holding. `TiebreakStep` is a union on `rule` rather than one
shape with an optional `matchups`, so a head-to-head step cannot be read
without them — they are what that rule counted, not an extra it might carry.
There is deliberately no fallback for a browser holding this code against an
older `star_round`: the app deploys on push and the migration applies on the
same merge, so that window is minutes long, and a branch nothing reaches after
them is worse than the window is.

### The About page and its sample poll

The [About](src/pages/About.tsx) page is public, and the people who most need
it arrived from a share link and have never heard of the method. It is in
three parts, and only one of them is a tab:

- the sentence saying what this is,
- **the two sample links**,
- the procedure, the site's features and the case for STAR, behind
  `Procedure` / `Site features` / `Benefits` tabs.

The three tabbed parts are reference rather than argument: nobody reads all
three in order, and stacked one after another they made a page long enough
that the sample links scrolled away from the paragraph that says why you would
want them. What is *not* tabbed is what every reader needs on arrival.

**Each tab carries its own footnotes, numbered from 1.** The procedure's two
are the tie-break rules; the case for STAR has three caveats of its own; the
site's features have none. One shared list has to be readable from whichever
tab is open, so it sat under all of them and made every reader of the
procedure scroll past three notes about an argument they had not read yet.
Nothing is cross-referenced between the tabs, so there is nothing to lose by
splitting it. If you move a note from one tab to the other, renumber the
`<Footnote n={…} />` markers in both: they are written down rather than
derived, because they sit inside prose.

#### The sample poll is a recording, not rows

`/#/polls/sample-host` is a three-question poll ("Movie night") still taking
votes; `/#/polls/sample-result-host` is the same poll after nine people
finished it. Neither exists in Supabase. Both are answered in the browser from
[`src/lib/samplePollData.ts`](src/lib/samplePollData.ts), which
`scripts/sample-poll.sh` generates by building a throwaway database from the
migrations (the same one `npm test` uses, and with the same requirements),
creating the poll in it **through the app's own write path**
(`create_poll_group`, `open_poll_submit`, `close_poll`), and recording what
`open_poll_view`, `open_poll_results`, `open_poll_ranking` and
`open_poll_ballots` answer about it.

Two rules, and everything else here follows from them.

**Nothing about the sample is computed in the browser.** Every tally,
tie-break, runoff and placing in that file came out of `star_round()` and
`poll_ranking()`. A TypeScript reimplementation of STAR for the sample would
be a second answer to the only question this app exists to answer, free to
disagree with the first — and it would disagree silently, since the page it
renders looks equally plausible either way. To change what the sample shows,
change the ballots in [`scripts/sample-poll.sql`](scripts/sample-poll.sql) and
run `scripts/sample-poll.sh`; whatever STAR then makes of them is what the
page shows.

**Nothing about the sample is in the database.** Rows there would be deleted
by the nightly retention purge six months after they were created (see [Polls
are deleted after six months](#polls-are-deleted-after-six-months)), and until
then anyone holding the link could vote in the poll the About page promises to
explain, which would move the tie-break out from under the explanation. A file
has neither problem, and a sample poll is content: it belongs with the page
that links to it.

The generator pins what would otherwise churn — option ids, group ids and the
closing timestamp are all derived from the readable name each question is
recorded under, and the poll ids simply *are* that name — so regenerating the
file produces a diff only where the poll actually changed.

#### How the pages know

They do not. `PublicPoll` renders a sample id exactly as it renders a real
one, because every open-poll call goes through `openPollRpc` in
[`src/lib/samplePoll.ts`](src/lib/samplePoll.ts) and that function is the only
thing in the app that decides what answers it. A real poll id is a v4 UUID, so
the `sample-` prefix cannot collide with one — which is also why the sample's
ids are words: a poll's id is its link, and these two links are meant to be
read in an address bar and said out loud. They are ids the `polls` table would
refuse, which is safe precisely because the sample never reaches it.

**One thing outside that file has to recognise a sample id: the router.**
`PollPage` in [`src/App.tsx`](src/App.tsx) sends a sample id straight to
`PublicPoll` instead of offering it to the account reading first. Every other
address is offered to `PollDetail` and falls back when row-level security
returns nothing (see [A poll's link is its id](#a-polls-link-is-its-id)), but a
sample id has no row for that read to miss — `select * from polls where id =
'sample-host'` does not come back empty, it errors on the cast, and
`invalid input syntax for type uuid: "sample-host"` is what a signed-in reader
got where the sample should have been. The `sample-` prefix has to be checked
before anything puts one of these ids in front of the database, which is why
`isSampleId` is exported rather than private to `openPollRpc`.

It is the one address with nothing to fall back to, and deliberately so: a
`sample-` id no question is recorded under is a mistyped sample link and
nothing else, so it gets `PublicPoll`'s own *poll not found* rather than the
sign-in screen a signed-out reader is offered for a poll they might turn out
to be invited to.

This never came up under the two routes that preceded one address per poll:
`#/p/:token` went to the public reading and nowhere else, so the sample could
not reach `PollDetail` however it was linked.

`scripts/sample-poll.sql` therefore keeps a `sample.link` table of its own for
the length of a run, standing in for the `public_token` column that used to
hold those words. The poll is built and voted through the real functions
against real uuids; the readable name is substituted into the recorded text
afterwards, which is where the ids were already being made deterministic.

Three consequences worth knowing:

- **The data is `import()`ed**, not bundled. It is forty-odd kilobytes of
  recorded JSON and most readers never open the sample.
- **The open copy takes a vote**, and behaves afterwards exactly as a real poll
  does — your vote is in, you can change it, you are on the roster. The ballot
  is kept in `localStorage` and goes nowhere else, which the poll's own
  description says in the first line a voter reads.
- **The sample is never watched.** Subscribing is also what triggers every
  other poll's first read (see [Live updates](#live-updates)), so `PublicPoll`
  reads the sample itself, once. There is nothing on the other end of a
  subscription to a file.
