# STAR Voting

A small app for running [STAR voting](https://www.starvoting.org/) (Score Then Automatic Runoff) polls among a chosen list of people. Sign in with an emailed magic link, create a poll with candidates and a list of invited emails, and results unlock automatically once everyone invited has voted.

Stack: React + Vite, [Mantine](https://mantine.dev), [Supabase](https://supabase.com) (Postgres + Auth), deployed to GitHub Pages.

## One-time setup

### 1. Supabase

1. Create a project at [supabase.com](https://supabase.com). Recommended project-creation settings: **Enable Data API** on, **Automatically expose new tables** off (the migration below grants API access to exactly the tables/roles it needs, so this isn't required), **Enable automatic RLS** on (safety net for any table added later outside the migration).
2. In the SQL Editor, run [`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql). This creates the tables, row-level security policies, table-level API grants, and the `submit_ballot` / `poll_status` / `get_poll_results` functions the app relies on.
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
