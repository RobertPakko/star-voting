# AGENTS.md

Working notes for this repo: how to set it up, how the pieces fit, and the
reasoning behind behaviour that would otherwise look arbitrary. The
[README](README.md) is deliberately kept to "what is this and why would I use
it" — everything technical belongs here.

## Stack and layout

React 19 + Vite, [Mantine](https://mantine.dev) for UI,
[Supabase](https://supabase.com) for Postgres and auth, `react-router-dom` with
hash-based routing, deployed to GitHub Pages by
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml).

```
src/pages/       route components (SignIn, PollList, CreatePoll, PollDetail, PublicPoll, About)
src/components/  poll UI pieces (Results, Ballots, Respondents, CreatorControls, …)
src/lib/         supabase client, auth context, share-link/QR/voter-key helpers, badge palette, field limits, settled-poll cache, shared types
supabase/migrations/  the schema, as ordered SQL files
supabase/after-squash.sql  the statements a schema dump cannot carry
scripts/         squash.sh, which squashes the migrations and replays the above
test/            tally tests, run against a throwaway Postgres
```

Scripts: `npm run dev`, `npm run build` (`tsc -b && vite build`),
`npm run lint` (oxlint), `npm run fmt` (oxfmt; `npm run fmt:check` reports
without writing), `npm run preview`, `npm test` (see [Tests](#tests)).

The formatter is configured in `.oxfmtrc.json` to the style the code was
already written in — no semicolons, single quotes, a hundred columns — and
skips Markdown, since this file and the README are wrapped by hand and the
wrapping carries meaning.

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

### 4. Invite emails

Inviting someone to a poll (`create_poll` inserting into `invited_voters`)
sends them an email through [Resend](https://resend.com), via a trigger
(`send_invite_email`, in the squashed baseline under
[`supabase/migrations/`](supabase/migrations)) that calls Resend's HTTP API
directly using `pg_net`. The API key is never
committed — the trigger reads it from Supabase Vault at send time:

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
   the key automatically.

This only works against a real Supabase project: `pg_net` and Vault don't
exist in the throwaway database `npm test` builds, so the trigger checks for
both schemas first and quietly does nothing if either is missing — invite
emails are best-effort and never block or fail an invitation itself.

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
`test/sql/cases/`, and reports each assertion.

Requirements are a Postgres server and a role that can create databases —
`PGHOST`, `PGUSER` and friends are honoured, and with none set it falls back to
a local cluster and starts one if it is not already running. There is no test
framework and nothing to `npm install`. CI runs the same script against a
`postgres` service container
([`.github/workflows/test.yml`](.github/workflows/test.yml)).

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
creator's own corrections before the first vote — and what an open poll's
share link discloses about the poll, including that the winner is not computed
until there is one.

Not covered: RLS policies and the `auth.jwt()`-gated access rules. The shim in
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

Poll pages re-read themselves every few seconds so votes appear without a
reload: `src/lib/useLiveRefresh.ts` is the timer, and `LIVE_REFRESH_MS` is
the one interval every live surface in the app runs at.

**Polling, not Supabase Realtime.** Realtime streams row changes over a
websocket, and subscribing to a table's changes needs a `SELECT` grant on
that table. `anon` deliberately has none, on any table — an open poll's
voters reach their poll entirely through the `open_poll_*` functions, which
is what stops a share token from also being a key to the rest of the schema.
Streaming would therefore mean either opening those tables to `anon` and
re-deriving every access rule in this file as an RLS policy, or streaming to
signed-in voters and polling for everyone else anyway. Re-calling the RPCs
the pages already use keeps one access path and one set of rules, and a poll
big enough for the difference in load to matter is not the kind of poll this
app is for.

Five rules keep it honest:

- **There is no live indicator, deliberately.** A page that updates itself
  demonstrates that by updating itself; a dot claiming it does is one more
  thing to read and one more thing to keep true.
- **The page owns the poll; components render what they are handed.** Both
  pages carrying an open poll read `open_poll_view` and hand it to
  `OpenPollPanel`, which used to fetch its own copy. Two copies on two
  timers could disagree about whether the poll had closed, and would have
  disagreed visibly — the tags row says *Closed* while the panel below it
  still shows a ballot. `Respondents` is the same idea from the other end:
  it reloads on the page's `liveTick` rather than a timer of its own, so the
  roster and the turnout count above it are always read at the same moment.
- **A refresh that fails changes nothing on screen.** Every live reload
  keeps the last good copy and tries again on the next tick. Only a *first*
  read that fails is allowed to produce an error, because only then is there
  nothing to show — a page that has been working for ten minutes must not
  turn into "poll not found" because one request lost a race with a flaky
  connection.
- **Refreshing stops when nobody is watching, and resumes on its own.** A
  hidden tab stops entirely — nobody is reading a backgrounded poll, and a
  laptop lid closed on twenty of them should not keep talking to the
  database — and coming back to the tab refreshes immediately rather than
  waiting out an interval. `LIVE_REFRESH_LIMIT` does the same job for a tab
  left open in the foreground and forgotten: after half an hour of
  refreshing with no sign of a reader it stops, and the first click, key or
  scroll resets the budget and refreshes at once. The one case this gets
  wrong is a poll parked on a projector that nobody touches for half an
  hour; raising the limit is the fix if that becomes a real complaint.
- **Refreshing stops when there is nothing left to watch.** A closed poll,
  or one whose results are out, has taken its last vote. The poll list is
  the exception and stays live for as long as it is on screen: any poll on
  it can take a vote, and a new invite can add a row.

Requests are chained rather than fired on a fixed interval — the next goes
out after the last comes back — so a slow connection spaces refreshes out
instead of stacking them up.

One request per page on a first load, and one per tick after that. The pages
carrying a state badge can make a second: they ask `poll_winners()` for the
finished polls whose result they cannot already name, which is a request on a
first look and nothing on the ticks after it. See [The poll's high-level
details](#the-polls-high-level-details) for why that is a request of its own,
and [Settled polls](#settled-polls) for why it stops.

In `npm run dev` every one of those appears twice: React's `StrictMode` mounts
each component, unmounts it and mounts it again, so every effect that fetches
runs twice. That is development-only and deliberate — it is what catches an
effect whose cleanup does not work — and `npm run build` output does it
once. Count requests against `npm run preview`, not `npm run dev`. Against a
real Supabase project each request is also preceded by a CORS preflight
`OPTIONS`, so the browser's network panel shows two entries per call.

## Settled polls

Live updates are for what can change. This is its mirror image: a poll whose
results are out has taken its last vote, so its tally, its ballot grid and
the option it elected are fixed for good, and re-reading them is work that
can only ever produce the same answer. `src/lib/settled.ts` remembers all
three, and it is what makes the winner badge cost one request per poll rather
than one per refresh.

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
is stated in full while it matters, by the option-collecting stage itself
(`CollectOptions`), and by the state badge reading *Collecting options*.

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

**The public voting page draws all four parts too**, and `0029` is what let
it: both of the ones it used to leave blank now come out of
`open_poll_view()`, which is the only thing that page can ask.

- **Who created it** is the creator's own email address, published to whoever
  the share link reaches. That is a deliberate disclosure, taken for
  consistency: an invite poll that shows respondents already names people by
  email, and of everyone in a poll the creator is the one who chose to be in
  it.
- **Which option won** was never actually withheld here — the tally under the
  heading has always named it in full. What was missing was the name *in the
  badge*, because that name comes from `poll_winners()` and that function
  answers only to an account; so the badge read *Results ready* next to a
  result sitting right underneath it.

**The winner is computed only once the results are out, and that condition is
the whole of what keeps it affordable.** Both pages that call
`open_poll_view()` re-read it every few seconds while the poll is live and
stop the moment the results unlock, so `poll_winner_name()` runs on the tick
that discovers the poll has finished and on later page loads — never on a
repeating timer. Computing it unconditionally would re-run the whole of STAR
on every tick of every open poll in the app, which is the same trap
`list_polls()` avoids by not carrying a `winner_name` column.

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

That last row is a real state rather than a fallback: on the poll list the
name arrives in a request behind the page, and a browser talking to a database
older than `poll_winners()` — or, on the public voting page, older than the
`winner_name` that `0029` added to `open_poll_view()` — never learns it at
all. It must never read as *Tied*, which would be a wrong answer where this is
only a missing one.

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
an election. The public voting page does not go through it — it has no account
to ask with — and gets the same name from `poll_winner_name()` inside
`open_poll_view()` instead. One election implementation, three callers of it,
so no two readers of a poll can be told different things about who won.

A browser holding a build newer than the database it is talking to reads
*Results ready* too — the app deploys on push while migrations land on merge,
so for a few minutes `poll_winners()` may not exist yet. That failure is
swallowed on purpose: a list with no winners named on it is a working list,
where a list that 404s is not.

The poll page asks the same function through `useWinner`, and through the same
cache, so opening a poll from the list — which is how most people open one —
costs no request at all and cannot disagree with the card it was opened from.

**Ten polls to a page.** The list is read whole and paged in the browser:
`list_polls()` returns the polls you were invited to, which is a number in the
tens for anyone this app is for, and paging in the database would cost the
live refresh its one round trip for nothing. The page number is clamped at
render rather than reset, so a poll deleted from page three leaves the reader
on page three — or on the last page there is, if that was it.

### Option descriptions

An option can carry a description as well as a name: a caveat, a couple of
lines of detail, a link to whatever is being voted on. It is optional and
nearly always absent, so it is not a field that is always on screen — each row
of the create form has a `+` beside it that opens one, and `0019` is the
migration that gave `create_poll` somewhere to put the text. The column itself
predates that by a long way: `candidates.description` and both ballots'
rendering of it were written first, and nothing had ever been able to fill it
in.

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
- **Hidden means gone.** Collapsing the field discards what was in it rather
  than remembering it, so a poll can never carry a description its creator can
  no longer see. It is also why "no description" is `null` rather than an empty
  string in the form state: the same value collapses the field and means there
  is nothing to store.
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
  more.

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

Like everything else about a poll, a description is fixed at creation; the
options of a poll with votes in it cannot change at all
(`guard_options_frozen`). Duplicating a poll copies the descriptions with the
options, which is the only way to get a nearly-identical poll with the
explanations intact.

### Who can vote

|  | **Invited people** | **Anyone with the link** |
| --- | --- | --- |
| Access | Email addresses on the invite list | An unguessable share link |
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

### Whether respondents are shown

- **Shown** — everyone in the poll can see who has responded and who hasn't,
  while voting is still open. Invite polls list the invited email addresses;
  open polls ask each voter for a name and list those. Useful when you want to
  know whose vote you are still waiting on.
- **Hidden** — only the number of votes is shown, to everyone including the
  creator.

This controls *who responded*, never *how they voted*.

**The roster is held back until you have voted; the count never is.** The two
used to be withheld together, which was one rule too many — they are not the
same disclosure.

What the roster leaks is *names attached to the moment each one arrived*.
Watching it fill up is a live feed of the arrival order, and that order is
what the published ballots work to keep off the record by sorting themselves
on `md5(id)` rather than on time. Note that the roster itself is alphabetical
(`order by lower(voter_name)`) — the leak is in watching it grow, not in
reading it once. Withholding it until you vote leaves that order visible only
to people actually in the poll rather than to anyone holding a link. It
narrows the leak without closing it: a voter still sees everyone who arrives
after them.

A bare count leaks neither half. It names nobody, and it says nothing about
any ballot — so it is on every screen a poll appears on, before you vote and
after. What a poll keeps from its voters is how it is **going**, and turnout
is not that: the standings stay sealed until the results unlock, in both
modes, and no count moves them. The poll list has shown `3/6 voted` for polls
you had not voted in since long before this was written down, which is the
app's actual position on whether the number is secret.

Two things are exempt. The **creator**, who sees participation whether or not
they have voted: the roster is what *Close voting now* gets decided on, and a
creator who isn't on the invite list could never earn the view by voting. On
invite polls it is also where the invite list is managed. And a **poll whose
results are out**, to everyone in it: the embargo exists because a ballot might
still be cast, and on that poll none can.

On open polls "you have voted" is the `localStorage` voter key, so clearing site
data hides the roster again. That is the same deliberately-weak signal behind
"your vote is in" — a convenience, not a guard, and accepted as such here.

**Turnout is reported in exactly one place on any screen**, and that place is
the count badge in the poll's header — the same badge, in the same position,
on the list and on the poll's own page. One fact stated twice reads as two
facts that happen to agree, which is why the results no longer open with "6 of
6 invited voters participated" and why neither roster carries a count of its
own any more.

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
  time.** This matters: on an open poll that shows respondents, names appear in
  the voter list as people vote, so anyone refreshing the page while voting is
  open learns the arrival order. Handing ballots back in submission order would
  re-attach those names to ballots the poll deliberately left unnamed.

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
in place of the ballot, on all three pages that can carry one. Everyone sees
the same list and the same box to add to it; the creator additionally gets a
`×` on each row, which sits beside the list it acts on rather than in
`CreatorControls`, the same way the invite controls sit inside `Respondents`.
Ending the stage is the other way round — that is something the creator does
to the *poll*, so **Open poll** is in `CreatorControls`.

**Reset votes leaves a finalized poll finalized.** Resetting promises the same
poll with its votes cleared, and the list everyone was shown is part of the
same poll. A poll closed while it was still collecting does reopen collecting,
because that is the stage it was in.

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

**What it does not promise is that nobody is looking at the old list.**
Someone with the ballot already on screen picks the correction up on the next
live tick, and a submit inside that window is refused rather than filed:
`submit_ballot` and `open_poll_submit` both demand a score for every option,
and both reject an id that is not on the poll — so a stale ballot fails
whether the list got longer, got shorter, or had one option swapped for
another at the same length. Being told to try again is the safe half of that
trade; the unsafe half would be a ballot silently scoring an option nobody
showed the voter.

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
- **Edit options** — while the poll has no votes in it: swaps the ballot for
  the option list so it can be corrected. The way back out is **Done**, under
  the list itself, and this button is not offered while that list is up:
  finishing with something belongs beside the thing, not in a block further
  down the page. See [The creator can correct the options until somebody
  votes](#the-creator-can-correct-the-options-until-somebody-votes).
- **Close voting** — reveals results using the votes cast so far. One-way.
- **Duplicate** — opens the create form prefilled from this poll (options,
  invitees, all four settings). Nothing is created until submit, so the copy
  can be edited first, and the original is untouched.
- **Reset votes** — deletes every vote and reopens the poll, keeping its id,
  options, invitee list and share link. Anyone who already voted can vote again,
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
page already asks for on a timer — rather than as a column on the `polls`
select. The app deploys on push and its migrations apply on merge, so a
browser can be a few minutes ahead of the database: an extra RPC column it
does not know about is `undefined` and says nothing, where a select naming a
column that does not exist yet fails outright and takes the poll page with it.

`RetentionNote` (`src/components/RetentionNote.tsx`) is the line at the foot
of the poll page, shown to everyone the poll admits rather than to its creator
alone — an invitee's ballot is in there too. It is quiet for almost all of a
poll's life and becomes an orange warning in the last month, when there is
still time to act on it. Only the creator is pointed at **Duplicate** there:
an invitee has no such button, and being told to press one you do not have is
worse than being told nothing. An automatic deletion is only fair if it was
never a surprise, which is the whole reason the date is on the poll from the
day it is created — and why it is the same date on the last day as on the
first.

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
