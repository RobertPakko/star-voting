import { z } from 'zod'
import type { BallotSheet, OpenPollView, PollRead, PollResults, PollStatus } from './types'

/**
 * What the app is willing to believe an RPC answered with.
 *
 * Six of this app's ten read paths return `jsonb`, so nothing at the type
 * level can describe them: PostgREST hands back `unknown` and every call site
 * used to close the gap with `data as PollRead`, which is a promise to the
 * compiler and no kind of check at all. The failure that promise hides is
 * specific and reachable — this app deploys on push and its migrations apply
 * on merge, so a browser can be a deploy behind or ahead of the database it is
 * talking to. A renamed or missing column then arrives as `undefined`, and
 * `undefined` is falsy: `status.results_available` reads as "not out yet" and
 * the page draws a ballot for a poll that has finished. No error anywhere.
 *
 * These schemas are the check. A read that does not match is a read that
 * failed, reported through the same channel a dropped request is, rather than
 * rendered from.
 *
 * **Unknown keys are stripped, not rejected.** That is the whole of how a
 * browser survives a database ahead of it: a column added by a migration this
 * bundle has never heard of is dropped on the way in and nothing breaks. The
 * other direction — a browser ahead of the database — is what the `.optional()`
 * markers are for, and they mirror the ones in `types.ts` exactly. Making
 * these strict would turn every forward migration into an outage.
 *
 * **The shapes are not written twice.** Each schema is checked against the
 * interface it is for by `satisfies z.ZodType<T>`, so a schema that drifts
 * from `types.ts` fails the build rather than silently rejecting good data at
 * runtime. `types.ts` stays the documented source of truth; this file is what
 * makes it true.
 *
 * Only the `jsonb` payloads are here. The three functions that return
 * `TABLE(...)` — `poll_status`, `list_polls`, `poll_invitees` — have a real
 * shape in the schema, so `database.types.ts` covers those at build time and
 * a runtime check would be the second belt. `PollStatus` appears anyway,
 * because it travels *inside* `poll_page`'s json.
 *
 * **What this costs.** Zod is on the critical path — the read that opens a
 * poll is checked by it — so it cannot sit behind a lazy boundary and its
 * weight is first-paint weight: 24.5 kB gzipped, measured on this app, which
 * is roughly what the route splitting in App.tsx bought back. That is a
 * deliberate trade rather than an oversight. `zod/mini` is the same validator
 * with the same `safeParse` behind a functional API and costs 7.3 kB; it was
 * measured and passed over, because a schema file is read far more often than
 * it is loaded and the chained API is the one everybody already knows.
 */

const pollMode = z.enum(['invite', 'open'])
const pollKind = z.enum(['option', 'time'])

/**
 * The grid a time poll's ballot is drawn on. Checked rather than waved
 * through, because it is the one payload the app does arithmetic with: the
 * calendar enumerates cells from these four numbers and flattens a painting
 * back through them, and a `granularity` that arrived as a string would make
 * every window start `NaN` several screens away from here.
 */
const pollSchedule = z.object({
  timezone: z.string(),
  window: z.object({ start: z.string(), end: z.string() }),
  desired_slots: z.number(),
  granularity: z.number(),
})

const pollOption = z.object({
  id: z.string(),
  poll_id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  sort_order: z.number(),
})

const poll = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  created_by: z.string(),
  created_by_email: z.string(),
  created_at: z.string(),
  closed_at: z.string().nullable(),
  mode: pollMode,
  show_voters: z.boolean(),
  show_ballots: z.boolean(),
  solicit_options: z.boolean(),
  options_finalized_at: z.string().nullable(),
  group_id: z.string().nullable(),
  question_position: z.number().nullable(),
  question_title: z.string().nullable(),
  kind: pollKind.optional(),
  schedule: pollSchedule.nullable().optional(),
})

const groupQuestion = z.object({
  id: z.string(),
  question_position: z.number(),
  question_title: z.string(),
  option_count: z.number(),
  voted: z.boolean(),
  confirmed: z.boolean().optional(),
})

const openGroupQuestion = z.object({
  id: z.string(),
  question_position: z.number(),
  question_title: z.string(),
})

/** `poll_group`, which the duplicate form reads to copy a whole group. */
export const groupQuestionsSchema = z.array(groupQuestion)

const invitee = z.object({
  email: z.string(),
  has_voted: z.boolean().nullable(),
  has_confirmed: z.boolean().nullable().optional(),
})

export const pollStatusSchema = z.object({
  invited_count: z.number(),
  voted_count: z.number(),
  is_complete: z.boolean(),
  voted: z.boolean(),
  is_closed: z.boolean(),
  results_available: z.boolean(),
  soliciting: z.boolean(),
  expires_at: z.string().nullable().optional(),
  invited: z.boolean().optional(),
  confirmed: z.boolean().optional(),
  confirmed_count: z.number().optional(),
  winner_name: z.string().nullable().optional(),
  winner_settled: z.boolean().optional(),
}) satisfies z.ZodType<PollStatus>

export const openPollViewSchema = z.object({
  poll: z.object({
    id: z.string(),
    title: z.string(),
    description: z.string().nullable(),
    mode: pollMode,
    show_voters: z.boolean(),
    show_ballots: z.boolean(),
    solicit_options: z.boolean(),
    closed_at: z.string().nullable(),
    group_id: z.string().nullable().optional(),
    question_position: z.number().nullable().optional(),
    question_title: z.string().nullable().optional(),
    kind: pollKind.optional(),
    schedule: pollSchedule.nullable().optional(),
  }),
  options: z.array(pollOption),
  voted_count: z.number(),
  is_closed: z.boolean(),
  soliciting: z.boolean(),
  results_available: z.boolean(),
  winner_name: z.string().nullable().optional(),
  winner_settled: z.boolean().optional(),
  voted: z.boolean(),
  your_name: z.string().nullable(),
  your_scores: z.record(z.string(), z.number()).nullable().optional(),
  voters: z.array(z.string()).nullable(),
  confirmed: z.boolean().optional(),
  your_confirmed_name: z.string().nullable().optional(),
  confirmed_count: z.number().optional(),
  confirmations: z.array(z.string()).nullable().optional(),
}) satisfies z.ZodType<OpenPollView>

const tiebreakEntry = z.object({
  id: z.string(),
  name: z.string(),
  value: z.number(),
})

const matchup = z.object({
  a: z.string(),
  a_name: z.string(),
  b: z.string(),
  b_name: z.string(),
  prefers_a: z.number(),
  prefers_b: z.number(),
  ties: z.number(),
})

// A union rather than one shape with an optional field, exactly as
// `TiebreakStep` is: the pairs are what the head-to-head rule counted, and
// there is no such thing to carry for a five-star count.
const tiebreakStep = z.discriminatedUnion('rule', [
  z.object({
    rule: z.literal('head_to_head'),
    results: z.array(tiebreakEntry),
    decisive: z.boolean(),
    matchups: z.array(matchup),
  }),
  z.object({
    rule: z.literal('five_star_votes'),
    results: z.array(tiebreakEntry),
    decisive: z.boolean(),
  }),
])

const tiebreak = z.object({
  tied_at: z.number(),
  tied: z.array(z.object({ id: z.string(), name: z.string(), total_score: z.number() })),
  slots: z.number(),
  steps: z.array(tiebreakStep),
  resolved_by: z.enum(['head_to_head', 'five_star_votes', 'random']),
  advanced: z.array(z.object({ id: z.string(), name: z.string() })),
})

const runoff = z.object({
  prefers_a: z.number(),
  prefers_b: z.number(),
  ties: z.number(),
  five_stars_a: z.number(),
  five_stars_b: z.number(),
  resolved_by: z.enum(['preference', 'higher_score', 'five_star_votes', 'unresolved']),
})

export const pollResultsSchema = z.object({
  options: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string().nullable().optional(),
      total_score: z.number(),
      average_score: z.number(),
    }),
  ),
  finalists: z.array(z.string()),
  tie: z.boolean(),
  tiebreaks: z.array(tiebreak),
  runoff: runoff.nullable(),
  winner_id: z.string().nullable(),
  voter_count: z.number(),
  invited_count: z.number(),
  mode: pollMode,
  closed_early: z.boolean(),
}) satisfies z.ZodType<PollResults>

export const rankingSchema = z.array(
  z.object({
    place: z.number(),
    options: z.array(z.object({ id: z.string(), name: z.string(), total_score: z.number() })),
    finalists: z.array(z.string()),
    runoff: runoff.nullable(),
    tiebreaks: z.array(tiebreak),
  }),
)

export const ballotSheetSchema = z.object({
  voters_named: z.boolean(),
  options: z.array(z.object({ id: z.string(), name: z.string() })),
  ballots: z.array(
    z.object({
      voter: z.string().nullable(),
      scores: z.record(z.string(), z.number()),
    }),
  ),
}) satisfies z.ZodType<BallotSheet>

/**
 * The read that opens a poll page, and the largest of these by some way: it
 * carries the poll, its options, its status, its group, the open view, the
 * tally, the published sheet and the roster, so checking it checks nearly
 * everything the app reads.
 *
 * A discriminated union on `kind`, which is also what replaces the hand-rolled
 * tag check `readPollPage` used to do — an answer that is none of the three
 * now fails here, with the same outcome.
 */
export const pollReadSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('account'),
    poll,
    options: z.array(pollOption),
    status: pollStatusSchema,
    questions: z.array(groupQuestion),
    view: openPollViewSchema.nullable(),
    results: pollResultsSchema.nullable(),
    ballots: ballotSheetSchema.nullable(),
    invitees: z.array(invitee).nullable(),
  }),
  z.object({
    kind: z.literal('open'),
    view: openPollViewSchema,
    questions: z.array(openGroupQuestion),
    results: pollResultsSchema.nullable(),
    ballots: ballotSheetSchema.nullable(),
  }),
  z.object({ kind: z.literal('unreadable') }),
]) satisfies z.ZodType<PollRead>

/**
 * Read an RPC answer, or say what was wrong with it.
 *
 * Returns the message rather than throwing, because every caller already has
 * somewhere to put one: a read that fails keeps the poll on screen and is
 * tried again, and a first read that fails reports itself. A parse failure is
 * the same kind of event as a dropped request, and is handled the same way.
 *
 * `what` names the call, since the reader who eventually sees this is the
 * person who can fix it and "invalid input" alone would not tell them where.
 */
export function parseAnswer<T>(
  schema: z.ZodType<T>,
  what: string,
  data: unknown,
): { value: T; error: null } | { value: null; error: string } {
  const result = schema.safeParse(data)
  if (result.success) return { value: result.data, error: null }

  // The first problem only. Zod reports every one, and a page is not the
  // place to read a list of them; the path is what identifies the field.
  const first = result.error.issues[0]
  const where = first?.path.length ? ` at ${first.path.join('.')}` : ''
  return { value: null, error: `${what} answered with something unexpected${where}.` }
}
