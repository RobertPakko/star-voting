# STAR Voting

A small app for running [STAR voting](https://www.starvoting.org/) (Score Then Automatic Runoff) polls. Sign in with an emailed magic link, create a poll, share it, and read the results once voting is done.

Stack: React + Vite, [Mantine](https://mantine.dev), [Supabase](https://supabase.com) (Postgres + Auth), deployed to GitHub Pages.

## Poll settings

Each poll picks two things at creation time. Neither can be changed afterwards.

### Who can vote

|  | **Invited people** | **Anyone with the link** |
| --- | --- | --- |
| Access | Email addresses on the invite list | An unguessable share link |
| Voter signs in | Yes, magic link | No |
| Results unlock | When everyone invited has voted, or when the creator closes the poll | Only when the creator closes the poll |
| One vote each | Enforced — one ballot per account | **Not** enforced |

An open poll cannot tell its voters apart. Anyone the link reaches can vote, and one person can vote more than once from another browser or after clearing site data. The app stores a random key in `localStorage` to stop accidental double-submits, but that is a convenience, not a guard. Use an open poll for picking a movie; use an invite poll for anything where the outcome matters.

Results stay hidden until they unlock, in both modes, so nobody ever votes knowing how it is going.

### Whether respondents are shown

- **Shown** — everyone in the poll can see who has responded and who hasn't, while voting is still open. Invite polls list the invited email addresses; open polls ask each voter for a name and list those. Useful when you want to know whose vote you are still waiting on.
- **Hidden** — only the number of votes is shown, to everyone including the creator.

This controls *who responded*, never *how they voted*. Individual scores are never readable through the API in either setting; results are only ever returned as an aggregate tally.

## Managing a poll

The creator gets these on the poll page:

- **Close voting now** — reveals results using the votes cast so far. One-way.
- **Duplicate** — opens the create form prefilled from this poll (options, invitees, both settings). Nothing is created until you submit, so the copy can be edited first, and the original is untouched.
- **Reset votes** — deletes every vote and reopens the poll, keeping its id, options, invitee list and share link. Anyone who already voted can vote again, and they aren't told the poll was reset.
- **Delete poll** — removes the poll and every vote cast, permanently.

Reset and delete both confirm first.

## Reading results

Results show the winner, every option's score-round total, any tie-break that had to be resolved, and the automatic runoff between the two finalists.

**See the full ranking** (on polls with more than two options) opens the whole field in placed order. STAR itself only names a winner, so the rest comes from running the method again on the options left standing: the winner steps out, the two highest scorers remaining go to a runoff for the next place, and so on down the list. Scores are absolute sums rather than transferable votes, so eliminating an option never changes anyone else's total — the score order is fixed, and each round is just the next runoff down it.

Two things this makes visible, and the modal says so:

- **The runner-up of the headline runoff is often not second.** It still has to beat the third-highest scorer, and it can lose that. An option can lead on points and place third.
- **Most pairs of options never meet.** Ordering n options takes n−1 runoffs, out of n(n−1)/2 possible pairings — a ladder, not a round-robin. Where two options did face each other the loser is always placed below the winner, but that guarantee covers only those pairs. Elsewhere an option can be preferred to one placed above it, and it takes no Condorcet cycle for that to happen: an option scoring too low to reach the first runoff enters the ladder below options it would have beaten. Only first place is STAR's official result.

## One-time setup

### 1. Supabase

1. Create a project at [supabase.com](https://supabase.com). Recommended project-creation settings: **Enable Data API** on, **Automatically expose new tables** off (the migrations grant API access to exactly the tables/roles they need, so this isn't required), **Enable automatic RLS** on (safety net for any table added later outside the migrations).
2. Connect the project to this repo under **Project Settings → Integrations → GitHub**, with `main` as the production branch. The migrations in [`supabase/migrations/`](supabase/migrations) are then applied for you — see [Database migrations](#database-migrations) below. Nothing needs pasting into the SQL Editor. No dashboard settings need changing for open polls either — the `anon` role's access is granted entirely by the migrations, and is limited to the three `open_poll_*` functions.
3. Under **Project Settings → API**, copy the Project URL and `anon` public key.
4. The **Email** auth provider (magic link) is enabled by default — no extra provider setup needed.
5. Under **Authentication → URL Configuration**, set the Site URL and add your dev URL (`http://localhost:5173`) and your GitHub Pages URL (`https://<your-username>.github.io/star-voting/`) to the allowed redirect URLs, or magic links won't be able to redirect back to the app.

### 2. Local development

```bash
cp .env.example .env
# fill in VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
npm install
npm run dev
```

### 3. GitHub Pages deployment

1. Repo **Settings → Pages** → set source to **GitHub Actions**.
2. Repo **Settings → Secrets and variables → Actions** → add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
3. Push to `main` — the [`deploy` workflow](.github/workflows/deploy.yml) builds and publishes automatically.

The app is served under `/star-voting/` (see `base` in `vite.config.ts`) and uses hash-based routing, so it works as a GitHub Pages project site without extra SPA-fallback configuration.

## Database migrations

Schema changes live as SQL files in [`supabase/migrations/`](supabase/migrations), named so they sort in the order they must run. They are **not** run by hand: Supabase's GitHub integration watches this repo, and any new migration file that lands on `main` is applied to the project automatically. Adding a schema change means committing the file and merging it — check the Supabase dashboard afterwards to confirm the run succeeded.

A migration that has already been applied is never re-run, so fixing a mistake means adding a new migration rather than editing the old file.

### Squashing

Migration files accumulate, and a long chain of them gets slow to run and hard to read. Occasionally collapse the whole history into a single baseline file:

```bash
npx supabase migration squash --linked
```

This replaces the existing files with one migration describing the current schema, and reconciles the linked project's migration history to match, so nothing is re-applied against the live database. Commit the result on its own, with no other changes in the same commit, so the replacement is easy to review.
