/**
 * 'invite' gates access by email address: only invited people can see or
 * vote, and results unlock on completion or when the creator closes.
 * 'open' gates access by an unguessable link: anyone holding it votes
 * without signing in, and results unlock only on close.
 */
export type PollMode = 'invite' | 'open'

export interface Poll {
  id: string
  title: string
  description: string | null
  created_by: string
  created_by_email: string
  created_at: string
  closed_at: string | null
  mode: PollMode
  /** Participants can see who has responded. */
  show_voters: boolean
  /**
   * Individual ballots are published once results unlock. Independent of
   * show_voters, which decides whether a name is attached to each one — so
   * `show_ballots && !show_voters` is a verifiable tally that names nobody.
   */
  show_ballots: boolean
  /** Set for open polls only; the capability in their share link. */
  public_token: string | null
}

// Backed by the "candidates" table in Postgres -- kept as-is there to
// avoid touching every policy/function for a cosmetic rename. The app
// itself calls these "options" everywhere.
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
  /** Every invited voter has cast a ballot. */
  is_complete: boolean
  /** The signed-in user has cast a ballot. */
  voted: boolean
  is_closed: boolean
  /** What actually gates the results view: complete, or closed with >=1 vote. */
  results_available: boolean
}

/** One row from list_polls(): a poll and its status, fetched together. */
export interface PollListItem extends Poll, PollStatus {}

export interface Invitee {
  email: string
  /** null when the poll hides respondents — show no badge, not "pending". */
  has_voted: boolean | null
}

/** Everything the public voting page needs, from one open_poll_view call. */
export interface OpenPollView {
  poll: {
    id: string
    title: string
    description: string | null
    mode: PollMode
    show_voters: boolean
    show_ballots: boolean
    closed_at: string | null
  }
  options: PollOption[]
  voted_count: number
  is_closed: boolean
  results_available: boolean
  /** This browser's voter_key has already submitted a ballot. */
  voted: boolean
  your_name: string | null
  /** Names of everyone who has responded; null when the poll hides them. */
  voters: string[] | null
}

export interface ResultOption {
  id: string
  name: string
  total_score: number
  average_score: number
}

export interface TiebreakEntry {
  id: string
  name: string
  value: number
}

/** One rule tried while resolving a tie, and whether it settled it. */
export interface TiebreakStep {
  rule: 'head_to_head' | 'five_star_votes'
  results: TiebreakEntry[]
  decisive: boolean
}

/** One tie encountered in the score round, and how STAR resolved it. */
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
  /** 'higher_score' means the runoff tied and STAR's score rule decided it. */
  resolved_by: 'preference' | 'higher_score' | 'unresolved'
}

/**
 * One place in the full ranking, which STAR produces by sequential
 * elimination: the winner steps out and the method runs again on what is
 * left. Only place 1 is STAR's official result.
 */
export interface RankingEntry {
  place: number
  /** Normally one option; two when a runoff tied on preference and score alike. */
  options: { id: string; name: string; total_score: number }[]
  /** The pair that contested this place -- one id when nothing else was left. */
  finalists: string[]
  /** null for the last option standing, which had nobody to run off against. */
  runoff: Runoff | null
  /** Ties resolved while choosing this place's finalists, not earlier ones. */
  tiebreaks: Tiebreak[]
}

export interface PollResults {
  options: ResultOption[]
  finalists: string[]
  /** Whether any tie-break was needed at all. */
  tie: boolean
  tiebreaks: Tiebreak[]
  runoff: Runoff | null
  winner_id: string | null
  /** Every option in placed order, first to last. */
  ranking: RankingEntry[]
  voter_count: number
  /** Always 0 for open polls — there is no invite list. */
  invited_count: number
  mode: PollMode
  /** Closed by the creator before everyone had voted. */
  closed_early: boolean
}

/** One voter's scores, keyed by option id. */
export interface Ballot {
  /** null on a poll that hides respondents — the ballot is unattributed. */
  voter: string | null
  scores: Record<string, number>
}

/**
 * Every ballot in a poll, for auditing the tally. Only returned once the
 * results themselves have unlocked, and only on a poll created with
 * show_ballots — see 0017.
 */
export interface BallotSheet {
  /** Mirrors the poll's show_voters: whether `voter` is filled in. */
  voters_named: boolean
  options: { id: string; name: string }[]
  /** Ordered by name, or by nothing at all when unnamed. Never by time. */
  ballots: Ballot[]
}
