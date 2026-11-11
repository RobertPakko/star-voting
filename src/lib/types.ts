/*
 * Shapes the RPCs hand back.
 *
 * Many fields below are optional only because the app deploys on push while
 * migrations apply on merge, so for a few minutes a browser can be ahead of
 * the database. Undefined in those fields means "not told", never "false".
 */

/**
 * 'invite' gates access by email address: results unlock on completion or
 * when the creator closes. 'open' gates access by an unguessable link: anyone
 * holding it may vote, and results unlock only on close.
 */
export type PollMode = 'invite' | 'open'

/**
 * What a question asks for, and so which result it opens on (the create
 * form's *Choice*; see lib/choices.ts). 'time' and 'consensus_time' are
 * meeting-slot polls whose options are window starts and whose ballot is a
 * calendar (`isCalendar`); every other kind is a written list scored 0-5.
 * 'option' and 'time' ask for STAR's winner, 'consensus' and
 * 'consensus_time' for the option whose lowest score is highest, the rest
 * for the option ranking, multiple winners or fractional winners.
 */
export type PollKind =
  | 'option'
  | 'time'
  | 'ranking'
  | 'multiple'
  | 'fractional'
  | 'consensus'
  | 'consensus_time'

/**
 * A time poll's grid; null on an ordinary poll. Which days and hours are asked
 * about is not stored -- `boundsOf` reads it back off the options.
 */
// A type alias, not an interface: it is sent into the database as jsonb, and
// an interface has no implicit index signature for PostgREST's `Json`.
export type PollSchedule = {
  /** A fixed UTC offset like `-07:00`, never a named zone (DST would make names ambiguous). */
  timezone: string
  /**
   * The grid's vertical axis as `HH:MM` (`end` may be `24:00`): the union of
   * every day's hours at creation. See `spanOf` and `axisFor`.
   */
  window: { start: string; end: string }
  /** Meeting length in granules: 3 at a granularity of 30 is 90 minutes. */
  desired_slots: number
  /** Minutes per granule; 1440 for a meeting of a day or more. See `granularityFor`. */
  granularity: number
}

export type DailyWindow = PollSchedule['window']

export interface Poll {
  id: string
  title: string
  description: string | null
  created_by: string
  /** Null for a poll made without an account. */
  created_by_email: string | null
  created_at: string
  closed_at: string | null
  mode: PollMode
  /** Undefined reads as an ordinary poll. */
  kind: PollKind
  schedule: PollSchedule | null
  /**
   * The kind's number: places to rank, or winners to choose. Null where the
   * kind takes none, or for as many as the results hold.
   */
  kind_value: number | null
  /** Participants can see who has responded. */
  show_voters: boolean
  /**
   * Ballots are published once results unlock. Independent of `show_voters`,
   * so published-but-unnamed is a verifiable tally that names nobody.
   */
  show_ballots: boolean
  /** The options were collected from participants. Frozen at creation. */
  solicit_options: boolean
  /** When collecting ended and voting opened; null while collecting or if never collecting. */
  options_finalized_at: string | null
  /** The multi-question poll this belongs to; null for a single-question poll. */
  group_id: string | null
  /** 1-based position in the group. */
  question_position: number | null
  question_title: string | null
}

/**
 * One question of a multi-question poll, as the question strip renders it.
 * The server can say what an invited (account) voter answered; for open
 * polls see `OpenGroupQuestion` and lib/questionMarks.ts.
 */
export interface GroupQuestion {
  id: string
  question_position: number
  question_title: string
  /** For the creator's *Open poll* button, which needs every question at two or more. */
  option_count: number
  /** The signed-in reader has voted in this question. */
  voted: boolean
  /** The signed-in reader has confirmed its options. */
  confirmed: boolean
}

export interface OpenGroupQuestion {
  id: string
  question_position: number
  question_title: string
  /**
   * The signed-in reader's account has voted here through the link. Absent
   * when signed out: per-question voter keys are deliberately unlinkable, so
   * only this browser can answer.
   */
  voted?: boolean
  confirmed?: boolean
}

// The "candidates" table; the app calls them options.
export interface PollOption {
  id: string
  poll_id: string
  name: string
  description: string | null
  sort_order: number
}

export interface PollStatus {
  invited_count: number
  voted_count: number
  /** Every invitee has voted. */
  is_complete: boolean
  /** The signed-in user has voted. */
  voted: boolean
  is_closed: boolean
  /** Complete, or closed with at least one vote. */
  results_available: boolean
  /** Still collecting options, so there is no ballot yet. */
  soliciting: boolean
  /** When the poll is purged: six months after creation, never moved. */
  expires_at: string | null
  /**
   * The reader is on the invite list -- not the same as being able to read
   * the poll (a creator who didn't invite themselves). Decides the confirm button.
   */
  invited: boolean
  /** The signed-in reader has confirmed the options. */
  confirmed: boolean
  /** How many invitees have confirmed. A count names nobody, so it's never hidden. */
  confirmed_count: number
  /**
   * The settled winner. Two fields for three answers: not settled
   * (`winner_settled` false), settled with nobody (null name), or a name.
   * Settled when the poll gets a result, cleared if it is reopened.
   */
  winner_name: string | null
  winner_settled: boolean
  /** When the poll's one reminder to vote was sent. */
  reminded_at: string | null
}

/**
 * The first read of a poll page, tagged with what this reader may see. `open`
 * deliberately carries less than `account`: no per-question marks, since an
 * open poll's per-question voter keys must not be joined. See `poll_page` and
 * `readPollPage`.
 */
export type PollRead = AccountRead | OpenRead | UnreadableRead

/** The poll to its creator or an invitee. */
export interface AccountRead {
  kind: 'account'
  poll: Poll
  options: PollOption[]
  status: PollStatus
  /** Empty on a single-question poll. */
  questions: GroupQuestion[]
  /** An open poll's view, for its creator (who manages it through the same panel). */
  view: OpenPollView | null
  /*
   * The card payloads below are carried when the page will draw them. Null
   * means "the card reads for itself", not "there is none" --
   * `status.results_available` is what says whether a result exists.
   */
  results: PollResults | null
  /** The published sheet, when results are out and ballots are published. */
  ballots: BallotSheet | null
  /** The invite list, when this reader draws a roster (the creator, or a poll showing respondents). */
  invitees: Invitee[] | null
  /** The reader's own scores on a finished private-ballot invite poll. */
  your_scores: Record<string, number> | null
  /** Whether the reader removed the poll from their list. See lib/removedPolls.ts. */
  removed: boolean
}

/** An open poll to anyone holding the link. */
export interface OpenRead {
  kind: 'open'
  view: OpenPollView
  questions: OpenGroupQuestion[]
  results: PollResults | null
  ballots: BallotSheet | null
  /** Always false when signed out. */
  removed: boolean
}

/** No such poll, or one this reader is not in -- deliberately indistinguishable. */
export interface UnreadableRead {
  kind: 'unreadable'
}

/** One row from list_polls(). */
export interface PollListItem extends Omit<Poll, 'created_by' | 'created_by_email'>, PollStatus {
  /** Null on an open poll listed only because this account answered it. */
  created_by: string | null
  created_by_email: string | null
  option_count: number
  /**
   * The row is a group's first question; other numbers on it are that
   * question's, except `is_closed`, `is_complete` and `results_available`.
   */
  question_count: number
  /** Total across all pages of the list being read, repeated on every row. */
  total_count: number
  /** How many polls the reader has removed; decides whether the Archived button shows. */
  removed_count: number
}

export interface Invitee {
  email: string
  /** Null when the poll hides respondents: show no badge, not "pending". */
  has_voted: boolean | null
  /** What the badge shows instead while collecting options. Null on the same terms. */
  has_confirmed: boolean | null
}

/** Everything the public voting page needs, from one open_poll_view call. */
export interface OpenPollView {
  poll: {
    id: string
    title: string
    description: string | null
    // No creator email: a share link goes wherever it is forwarded.
    mode: PollMode
    show_voters: boolean
    show_ballots: boolean
    solicit_options: boolean
    closed_at: string | null
    created_at: string
    group_id: string | null
    question_position: number | null
    question_title: string | null
    kind: PollKind
    schedule: PollSchedule | null
  }
  options: PollOption[]
  voted_count: number
  is_closed: boolean
  soliciting: boolean
  results_available: boolean
  /** Same terms as `PollStatus`. */
  winner_name: string | null
  winner_settled: boolean
  /** This reader (account, or browser key) has voted. */
  voted: boolean
  your_name: string | null
  /** This reader's own scores, so *Edit vote* needs no extra request. */
  your_scores: Record<string, number> | null
  /** Who has responded; null when the poll hides them. */
  voters: string[] | null
  confirmed: boolean
  /** Null on a poll that hides respondents (no name is stored). */
  your_confirmed_name: string | null
  confirmed_count: number
  /** Who has confirmed; null when the poll hides respondents. */
  confirmations: string[] | null
  /**
   * Whether the question carries earlier voters (a sequential poll). Optional
   * until 0101 has landed everywhere.
   */
  sequential?: boolean
  /**
   * The earlier voters still to vote, offered as names to pick; null where the
   * question is not sequential or hides who voted.
   */
  carried_names?: string[] | null
}

/** One option's score, from `get_poll_scores` / `open_poll_scores` (*All scores*). */
export interface OptionScore {
  id: string
  name: string
  total_score: number
  average_score: number
}

interface ResultOption {
  id: string
  name: string
  description: string | null
  total_score: number
  average_score: number
}

interface TiebreakEntry {
  id: string
  name: string
  value: number
}

/**
 * One head-to-head pair: voters preferring `a`, preferring `b`, and scoring
 * them equally (`ties` decides nothing, but lets a reader reach the turnout).
 */
interface Matchup {
  a: string
  a_name: string
  b: string
  b_name: string
  prefers_a: number
  prefers_b: number
  ties: number
}

/** One rule tried while resolving a tie. */
export type TiebreakStep = HeadToHeadStep | FiveStarStep

export interface HeadToHeadStep {
  rule: 'head_to_head'
  results: TiebreakEntry[]
  decisive: boolean
  /** Exactly one pair; an array because recorded results predate the change. */
  matchups: Matchup[]
}

export interface FiveStarStep {
  rule: 'five_star_votes'
  results: TiebreakEntry[]
  decisive: boolean
}

/** One tie in the score round, and how it was resolved. */
export interface Tiebreak {
  tied_at: number
  tied: { id: string; name: string; total_score: number }[]
  slots: number
  steps: TiebreakStep[]
  resolved_by: 'head_to_head' | 'five_star_votes' | 'random'
  advanced: { id: string; name: string }[]
}

/** A runoff between two finalists. 'a' is the higher scorer of the pair. */
export interface Runoff {
  prefers_a: number
  prefers_b: number
  ties: number
  /** Always present, so a reader can check rules that weren't reached. */
  five_stars_a: number
  five_stars_b: number
  /** 'unresolved' means all three rules were level: no winner. */
  resolved_by: 'preference' | 'higher_score' | 'five_star_votes' | 'unresolved'
}

/**
 * One place in the full ranking, by sequential elimination (only place 1 is
 * STAR proper). Fetched separately by `FullRanking`, since it is expensive,
 * and stopped by the database after the top places.
 */
export interface RankingEntry {
  place: number
  /** Two when a runoff tied on every rule. */
  options: { id: string; name: string; total_score: number }[]
  /** One id when nothing else was left. */
  finalists: string[]
  /**
   * The finalists' names, in the same order. The option a place beat may sit
   * below where the ladder stops, so it is named here rather than looked up.
   */
  finalist_names: string[]
  /** Null for the last option standing. */
  runoff: Runoff | null
  /** Ties resolved while choosing this place's finalists only. */
  tiebreaks: Tiebreak[]
}

/**
 * One option's share under *Fractional winners*, from
 * `get_poll_fractional_winners` / `open_poll_fractional_winners`: a fraction
 * of 1, the shares summing to 1 (or all 0 where nobody starred any of them).
 * Largest first, and only the options with the most stars.
 */
export interface FractionalShare {
  id: string
  name: string
  share: number
}

/**
 * The consensus, from `get_poll_consensus` / `open_poll_consensus`: the
 * option whose lowest score (its floor) is highest. Options sharing it are
 * compared on their next-lowest score, then the next, until one is ahead;
 * options level on every score leave no winner. Every ballot counts.
 */
export interface ConsensusResult {
  /** Null where two or more options were given exactly the same scores. */
  winner_id: string | null
  /** The highest floor: the fewest stars any ballot gave the winner. */
  floor: number
  /** How many options were counted (the poll's, less any left out). */
  option_count: number
  /** How many options share the highest floor; above one, a tie-break decided. */
  tied_count: number
  /** Ballots counted. */
  voter_count: number
  /**
   * Where the winner pulled ahead, counting each option's scores lowest
   * first: 1 on its floor, 2 on its next-lowest score. Null with no winner,
   * or no other option to beat.
   */
  decided_at: number | null
  /** The winner's score at `decided_at`. */
  winner_score: number | null
  /** The next option in the order, with its score at `decided_at`. */
  runner_up: { id: string; name: string; score: number } | null
  /** With no winner, the options level on every score (two or more); else empty. */
  level_ids: string[]
  level_names: string[]
  /** The top options in the consensus's order, the winner first. */
  options: { id: string; name: string; floor: number; total_score: number }[]
}

export interface PollResults {
  /** The score round's top rows only (`poll_results_rows()`); see `option_count`. */
  options: ResultOption[]
  /** How many options the poll has, of which `options` is the top. */
  option_count: number
  finalists: string[]
  /** Whether any tie-break was needed. */
  tie: boolean
  tiebreaks: Tiebreak[]
  runoff: Runoff | null
  winner_id: string | null
  voter_count: number
  /** Always 0 for open polls. */
  invited_count: number
  mode: PollMode
  /** Closed by the creator before everyone had voted. */
  closed_early: boolean
  /** The options were edited after ballots were in. Shown as a caveat under the winner. */
  options_edited_after_votes: boolean
  /** A vote was cast or changed after the tally had been shown (via a reopen). */
  votes_after_reveal: boolean
  /** The question's kind, which the results open on. */
  kind: PollKind
  /** Its number (`Poll.kind_value`): where the reader's count starts. */
  kind_value: number | null
  /**
   * The result the kind asks for, whole (every place the database counts),
   * when it is more than STAR's winner and the poll is big enough to offer
   * it. Places for a ranking or multiple winners, shares for fractional
   * winners, an object for the consensus; `chosenResult` in lib/choices.ts
   * tells them apart.
   */
  kind_result: RankingEntry[] | FractionalShare[] | ConsensusResult | null
  /**
   * Whether the ballots carry weights (a sequential poll): every count is
   * then a weighted sum. Optional until 0101 has landed everywhere.
   */
  weighted?: boolean
}

/** One voter's scores, keyed by option id. */
export interface Ballot {
  /** Null on a poll that hides respondents. */
  voter: string | null
  scores: Record<string, number>
  /**
   * On a sequential question, the stars this ballot's voter had given earlier
   * winners when it was cast (its weight is drawn from it; see
   * `lib/ballotWeight.ts`). Absent on every other ballot.
   */
  given?: number
}

/** Every ballot in a poll, for auditing. Returned only once results unlock. */
export interface BallotSheet {
  voters_named: boolean
  options: { id: string; name: string }[]
  /** Ordered by name, or by a hash when unnamed. Never by arrival time. */
  ballots: Ballot[]
}
