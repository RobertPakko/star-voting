# Schedule mode — implementation plan

**Status: a plan, not shipped behaviour.** Nothing described here exists yet.
`AGENTS.md` documents the app as it is; this file documents what a scheduling
poll is meant to become. Fold the parts that survive contact into `AGENTS.md`
when they land, and delete this file when it is done.

## The idea

A poll that finds a time instead of choosing an option, reusing the STAR
machinery unchanged.

A poll gains a type. `option` is everything the app does today. On a `time`
poll the creator says how long the meeting is, which timezone the poll is
held in, and what part of each day is in bounds; the app enumerates every
window of that length as an **option**, and voters rate those options 0–5 by
painting a calendar.

The trick is that the enumeration happens in the browser at creation, and the
painting is translated back into a score per option before it is sent. The
database stores a `time` poll exactly as it stores any other: rows in
`candidates`, rows in `scores`, one ballot per voter. `poll_tally`,
`star_round`, `settle_winner`, the RLS policies, the voter-key path, ballot
revision and the live stream are all untouched, because none of them knows
what an option means.

Worked example. A three-hour meeting, Monday to Friday, 8am–10pm, hourly
starts: twelve window starts a day, five days, sixty options. Each option is
one three-hour window. A voter who can do Tuesday afternoon and nothing else
scores the Tuesday afternoon windows highly and everything else 0.

## What is already decided

These were argued through before this file was written. They are settled;
don't relitigate them without new information.

**Near-identical windows taking both finalist slots is fine.** Adjacent
windows overlap heavily, so their totals and their per-ballot vectors are
nearly identical, and the top two by score will usually be neighbours. The
runoff then compares Tuesday 2pm against Tuesday 3pm rather than against a
genuinely different time. That is accepted: if the two best windows are two
shifted copies of the same slot, that slot is a good answer, which is what
the poll was asked for.

**Ties broken arbitrarily are fine.** Painting whole days — which the ballot
UI actively encourages — gives contiguous windows *identical* score vectors
from every voter. Identical totals, all head-to-heads tied, identical
five-star counts, so `star_round` falls through to `v_resolved := 'random'`
and orders by candidate id. Among genuinely equal windows any pick is a good
pick, and the ordering is at least stable across reads.

**The option cap is raised rather than worked around.** Sixty options is over
today's fifty. See *Schema* below for the shape of the change.

**A window's rating is the minimum of its hours.** A voter paints hours; the
ballot stores windows. The rating of a window is the *lowest* rating among
the hours it covers. Not the mean: with a mean, a window containing an hour
the voter flatly cannot attend still scores 3.3 and can win. With a minimum,
any window touching a 0 is a 0, which is exactly "I can't be there".

**One timezone per poll, declared by the creator.** Voters all see the same
grid, in the poll's timezone, whatever their own. This is what keeps option
names plain text and lets `winner_name` flow into the results email
unchanged. Distributed groups pay a conversion tax; that is the trade.

**Option solicitation is off for `time` polls, for now.** See *Out of scope*.

**The results view is reused as it stands.** No calendar heat-map. Each
option's name is its start date-time, which is already all the identity an
option has, and the existing results page ranks them by score. Simpler to
build, and a ranked list of times is a legible answer.

## Schema

One migration, `0055_*.sql`. Three things in it.

### 1. `polls.kind` and `polls.schedule`

`polls` has no type column and nowhere to put configuration — `description` is
the creator's prose. Add:

- `kind text not null default 'option'`, checked against
  `('option', 'time')`, matching how `mode` is done.
- `schedule jsonb`, null on an `option` poll, required on a `time` poll. A
  check constraint should tie the two together the way `polls_question_ck`
  ties the question columns together: `schedule` is null if and only if
  `kind = 'option'`.

`schedule` holds only what cannot be recovered from the options:

```json
{
  "timezone": "-07:00",
  "window": { "start": "08:00", "end": "22:00" },
  "slot_minutes": 180
}
```

The in-bounds *days* are deliberately not stored — they are exactly the set
of dates the options start on, so the client derives them and the two can
never disagree. `window` is stored even though it is nearly derivable,
because the grid needs a vertical axis on days whose options are sparse.

**Store a fixed UTC offset, not a named zone.** A named zone spanning a DST
transition gives one day 23 or 25 hours and a 1am that happens twice or not
at all, which makes the generated labels ambiguous in precisely the way
declaring a timezone was meant to prevent. If a named zone is wanted later,
refuse polls that span a transition.

Both columns need carrying through whichever of `poll_page`, `open_poll_view`,
`poll_group`, `open_poll_group` and `list_polls` the front end reads them
from, and through the zod schemas in `src/lib/rpcSchemas.ts`.

### 2. The option cap becomes type-aware

Today the cap is 50, and it is enforced in two and a half places:

- `MAX_OPTIONS` in `src/lib/limits.ts:41`, checked by the creation form
  (`src/pages/CreatePoll.tsx:270`) and the suggestion box
  (`src/components/CollectOptions.tsx:340`, `:384`).
- `insert_option` in `supabase/migrations/0053_baseline.sql:1024`, which is the
  path `creator_add_option` and the suggestion RPCs take.
- **Not** `insert_poll_row`, which inserts into `candidates` directly and
  checks nothing. A sixty-option poll created up front would be accepted today
  purely because of that gap.

Don't lean on the gap and don't raise the constant globally. `insert_option` is
reachable by `anon` through `open_poll_suggest_option`, so a global raise
widens the write surface on every open poll in the app. Make the cap a function
of `polls.kind` — leave `option` polls at 50, give `time` polls a ceiling
generous enough for a fortnight at half-hourly starts — and enforce it in
`insert_poll_row` as well, which closes the existing hole in the same breath.

### 3. A composite index on `scores`

```sql
create index idx_scores_ballot_candidate on scores (ballot_id, candidate_id);
```

This is not optional, and it is the one performance change that matters.

The tie-break block in `star_round` fires whenever a tied group is larger than
the finalist slots remaining — which the decisions above guarantee will be the
common case, not the rare one. It builds every ordered pair in the tied group
and cross-joins each against every ballot with two correlated lookups into
`scores`. Today the only usable index is `idx_scores_ballot_id`, so each lookup
scans that ballot's whole score row set and filters. At sixty options and a
thirty-way tie that is roughly 870 pairs × ballots × 120 row reads, per round.
With the composite index each lookup is a single hit.

It matters because of *where* that block runs. It is not confined to the
results page:

- `poll_tally` calls `star_round` once — every read of the results.
- `poll_winner_name` calls it, and `settle_winner` calls that **once per
  question in the group**, inside the transaction of the deciding ballot. The
  last voter to submit waits for it before their vote returns.
- `poll_ranking` (`0053_baseline.sql:2722`) calls it once per placed option.

So capping `poll_ranking` would not have helped the two paths a person
actually waits on. Add the index; measure before deciding whether anything
else is needed.

## The derivation

The one piece of real logic in the front end. Get it right and the rest is
plumbing.

**Creation.** From `schedule` plus the creator's chosen days, enumerate every
start time such that the whole window fits inside that day's in-bounds hours.
Each start is one option. The option's `name` is its start date-time,
formatted for a human to read in the poll's timezone — this string is what
`winner_name` stores and what the results email says, so it needs to read as a
time (`Tue 2 Sep, 2:00 PM`) rather than as a serial number. The duration is not
in the label; it comes from the poll's title, description and `schedule`.

Start times are naturally unique within a poll, which satisfies
`insert_option`'s case-insensitive duplicate check for the paths that use it.

**Voting.** The voter paints a rating per *hour* (or per `slot_minutes`
granule). For each option, take the minimum rating across the granules its
window covers. Untouched granules are 0, which is a real rating meaning
unavailable, consistent with how `BallotCard` already sends
`values[o.id] ?? 0`.

A consequence worth designing for: a voter whose longest free block is shorter
than the window scores *every* option 0 and contributes nothing. That is
correct, but it looks like the app ate their vote. Warn on the ballot before
submit — "you haven't marked any 3-hour block, so every option will score 0".

**Reading a ballot back.** `open_poll_revise` and `revise_ballot` return
scores per option. To repaint the calendar, invert: a granule's rating is the
maximum over the windows containing it, since a window's score was the minimum
over its granules. This is lossy — the original painting cannot always be
recovered exactly — so decide whether revision repaints from the derived
values or keeps the raw painting in browser storage alongside the ballot. The
derived repaint is simpler and probably good enough; the ballot is the thing of
record either way.

## Front end

**The calendar. `@mantine/schedule`, version 9.5.2.** Real and released, not
alpha. Be clear about what it is before building on it: an event calendar in
the Google Calendar mould — `Schedule`, `WeekView`, `DayView`, `MonthView`,
`AgendaView`, resource lanes, RFC 5545 recurrence, drag-and-drop and resize of
events. Its primitive is an event with a start, an end and a colour. It is
**not** an availability grid and has no notion of a rated cell.

The adaptation that works: `withDragSlotSelect` with
`onSlotDragEnd(rangeStart, rangeEnd)` gives the drag gesture, `onTimeSlotClick`
covers single taps, and each painted region is rendered as a background event
(`display: 'background'`) coloured by its rating, styled through
`renderEventBody`. The rating itself — which of the six levels the drag
applies — is the app's own control.

Costs to know before committing:

- It requires `@mantine/dates` and depends on `rrule`, and `@mantine/dates`
  peers on `dayjs`. Three packages, two of them recurrence and date machinery a
  rating grid never uses.
- Peer dependencies pin `@mantine/core`, `@mantine/hooks` and `@mantine/dates`
  to **exactly** 9.5.2. `package.json` currently has `^9.5.1`, which resolves,
  but from here every `@mantine/schedule` bump drags the others with it.
- The app installs to phones as a PWA. Measure the bundle delta before
  building on it, not after.

**The ballot.** A new component beside `BallotCard`, not a variant of it. It
produces the same `BallotScore[]` and hands it to the same `onSubmit`, so both
ballot paths — `submit_ballot` and `open_poll_submit` — work unchanged.

Note that `useBallotOrder` (`src/lib/ballotOrder.ts`) deliberately shuffles the
option list per browser, because position on a ballot is worth points. A
calendar is scanned rather than read top to bottom and its order is chronological
and meaningful, so the shuffle does not apply. If the time ballot never renders
a linear list this is moot; if a fallback list exists anywhere, it should stay
chronological, and that is a conscious exception to the rule that file argues
for.

**Creation.** A type toggle on the create form, and when it is `time`: a
timezone, a duration, a daily window, and a day picker. The form generates the
options and sends them through the existing `create_poll` / `create_poll_group`
path as ordinary option names.

**Results.** Unchanged, per the decision above. Confirm the runoff and
tie-break copy still reads sensibly when the two finalists are neighbouring
windows and the tie-break line says the tie was resolved at random — both will
be common. Rewording that copy for `time` polls is cheap and worth doing.

**Everything that assumed a short option list** needs a look at sixty-plus
options, not a rewrite: `FullRanking`, the published ballot sheet under
`show_ballots`, the option editor in `CreatorControls`, and the skeletons.

## Out of scope for the first pass

**Option solicitation on `time` polls.** Turn it off in the UI and refuse the
combination in `create_poll` / `create_poll_group`.

It is wanted eventually and the mechanics are settled: extend
`add_suggested_option` and `insert_option` so several options can be inserted
atomically, since a voter "adding Thursday" adds a dozen options — one per
window start — and a dozen separate calls can fail halfway or hit the cap
mid-expansion, leaving a Thursday with morning windows and no afternoon.

It is deferred because of a product risk rather than the mechanics. Solicitation
is a two-phase flow: propose options, confirm, creator finalizes, then vote. On
a time poll both phases are *the same gesture on the same calendar*. Phase one
means "these times should be on the ballot" and phase two means "here is how
much I like them", and there is every reason to expect people to paint their
availability in phase one and be confused at being asked again. Ship without
it, see whether anyone asks, and if they do, design it as an explicit "propose
more days" step rather than reusing the suggestion box.

**A calendar heat-map of results.** Decided against; the ranked list stands.

**Named timezones and DST-spanning polls.** Fixed offsets only.

**Cross-timezone rendering.** One poll, one timezone, everyone sees the same
grid.

## Tests

The suite is `npm test` — `test/run.sh` builds a database from
`supabase/migrations/` and runs each case in `test/sql/cases/`. Cases are
numbered; the next free number is 30. `tests.seed_poll(options[], scores[][])`
in `test/sql/helpers.sql` builds a poll with ballots in one call, which is
enough to exercise everything below.

At minimum:

- The migration applies. This comes free — the suite builds from the migration
  files, so a broken one fails everything.
- A `time` poll's `schedule` survives a round trip through whichever read RPCs
  carry it, and the check constraint refuses `kind = 'time'` with a null
  `schedule` and `kind = 'option'` with a non-null one.
- The type-aware cap: an `option` poll still refuses its 51st option through
  `insert_option`, a `time` poll accepts more, and `insert_poll_row` now
  refuses an over-cap creation it previously accepted.
- A sixty-option poll with the large tied groups these ballots produce runs
  `poll_tally`, `poll_ranking` and `settle_winner` within the statement
  timeout. This is the case that justifies the index; write it so that
  dropping the index makes it fail.

The derivation — enumeration and the minimum rule — is front-end logic and has
no home in the SQL suite. There is no JS test runner in the repo today. Either
add one for these two pure functions, or keep them pure and small enough to
read.

## Order of work

1. The migration: `kind`, `schedule`, the type-aware cap, the index. Plus the
   read RPCs and `src/lib/rpcSchemas.ts` that carry the new columns.
2. The pure functions: enumerate options from a `schedule`, derive option
   scores from a painting, invert for repaint. No UI.
3. The create form: type toggle and generation.
4. The ballot: `@mantine/schedule` painter, bundle measured.
5. Sweep the views that assumed a short list; reword the runoff and tie-break
   copy for `time` polls.
