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
src/lib/         supabase client, auth context, share-link/QR/voter-key helpers, badge palette, shared types
supabase/migrations/  the schema, as ordered SQL files
test/            tally tests, run against a throwaway Postgres
```

Scripts: `npm run dev`, `npm run build` (`tsc -b && vite build`),
`npm run lint` (oxlint), `npm run preview`, `npm test` (see [Tests](#tests)).

The app is served under `/star-voting/` (see `base` in `vite.config.ts`) and
routes are hash-based, so it works as a GitHub Pages project site with no
SPA-fallback configuration. Links into the app therefore look like
`…/star-voting/#/poll/<id>`.

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
   the `open_poll_*` functions (`view`, `submit`, `results`, `ballots`) — it has
   no read or write grant on any table.
3. Under **Project Settings → API**, copy the Project URL and `anon` public key.
4. The **Email** auth provider (magic link) is enabled by default — no extra
   provider setup needed.
5. Under **Authentication → URL Configuration**, set the Site URL and add your
   dev URL (`http://localhost:5173`) and your GitHub Pages URL
   (`https://<your-username>.github.io/star-voting/`) to the allowed redirect
   URLs, or magic links won't be able to redirect back to the app.

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
3. Push to `main` — the deploy workflow builds and publishes automatically.

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
npx supabase migration squash --linked
```

This replaces the existing files with one migration describing the current
schema, and reconciles the linked project's migration history to match, so
nothing is re-applied against the live database. Commit the result on its own,
with no other changes in the same commit, so the replacement is easy to review.

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
the runoff and its tie-breaks, the genuine-tie result, the full ranking, and the
`create_poll` / `submit_ballot` write path the seeding runs through.

Not covered: RLS policies and the `auth.jwt()`-gated access rules. The shim in
`test/sql/shim.sql` stands in for Supabase's `auth` schema with a one-row
session table, which is enough to let the migrations apply and to sign a seeded
voter in, but it is not Supabase's auth and a passing suite says nothing about
who is allowed to read a poll. `run.sh` also drops three extensions a stock
Postgres does not have and the `MAINTAIN` privilege, none of which the tally
touches. Everything else is applied verbatim, so the functions under test are
the ones that ship.

## Behaviour worth preserving

These are decisions, not accidents. Changing any of them changes a promise the
app makes to the people voting in it.

### Poll settings are frozen at creation

Each poll fixes three things when it is created, and none can be changed
afterwards: `authenticated` has no `UPDATE` grant on the `polls` table at all.
A poll's terms are settled the moment it exists.

All three are surfaced together by `PollTags` (`src/components/PollTags.tsx`) on
the poll list, the poll page and the public voting page — always all three,
always in the same order and the same words, whichever way each one is set. A
tag that appeared only for one of its two states made its absence carry meaning,
and nobody reads an absence. `Closed` is appended to the same row but is a
*state* rather than a setting, so it is grey and always last.

**Every state has its own colour**, not one colour per setting: with all three
tags always present, a colour shared across a pair told you which question was
being answered but not what the answer was, leaving the text to carry the whole
tag. Colours come from `src/lib/badgeColors.ts`, which holds every badge colour
in the app in one place — badges from different files land side by side on a
poll list card, so choosing at the call site is exactly how two unrelated
meanings end up the same colour. Add a key there before adding a badge.

The wording is deliberately not symmetrical. Respondents are **shown** or
**hidden** — hiding them lists nobody at all, which is not the same as listing
them anonymously — while ballots are **published** or **private**. An anonymous
ballot is the two tags in combination: respondents hidden, ballots published.
Changing any of these strings means changing them in `PollTags` alone, which is
the point of it existing.

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

Either way, participation is **held back until you have voted**. Someone still
looking at a blank ballot sees the ballot and the poll's tags, nothing else.
Two reasons: nothing in the roster helps you fill a ballot in, and on a poll
that names respondents it is a live feed of the arrival order — the same order
the anonymous ballot ordering below exists to keep off the published grid.
Withholding it until you vote leaves that order visible only to people actually
in the poll rather than to anyone holding the link. It narrows the leak without
closing it: a voter still sees everyone who arrives after them.

The **creator is exempt** and sees participation whether or not they have voted.
The roster is what *Close voting now* gets decided on, and a creator who isn't
on the invite list could never earn the view by voting. On invite polls it is
also where the invite list is managed.

On open polls "you have voted" is the `localStorage` voter key, so clearing site
data hides the roster again. That is the same deliberately-weak signal behind
"your vote is in" — a convenience, not a guard, and accepted as such here.

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
  states of all three settings: the alert restated what the tags already said,
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

### Creator controls

On the poll page, the creator gets:

- **Close voting now** — reveals results using the votes cast so far. One-way.
- **Duplicate** — opens the create form prefilled from this poll (options,
  invitees, all three settings). Nothing is created until submit, so the copy
  can be edited first, and the original is untouched.
- **Reset votes** — deletes every vote and reopens the poll, keeping its id,
  options, invitee list and share link. Anyone who already voted can vote again,
  and they aren't told the poll was reset.
- **Delete poll** — removes the poll and every vote cast, permanently.

Reset and delete both confirm first.

The **share link** sits in the same block (`src/components/ShareLink.tsx`),
with **Copy** and a **QR code** beside it. Handing the poll out is something
the creator does to the poll, not something a voter needs while scoring
options, and keeping it here means it is never withheld — the link has to go
out before anyone, the creator included, has voted. Open polls also offer it on
the thank-you card once you have voted, where passing it on is a reasonable
thing to want.

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
underneath, with column totals to check the score round against.

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
