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
   * show_voters, which decides whether a name is attached to each one so
   * `show_ballots && !show_voters` is a verifiable tally that names nobody.
   */
  show_ballots: boolean
  /**
   * The options were collected from the people in the poll rather than
   * written by its creator. Frozen at creation like the three above; what
   * moves is `options_finalized_at`.
   */
  solicit_options: boolean
  /**
   * When the creator closed the option list and opened voting. Null while a
   * soliciting poll is still collecting, and never set on a poll whose
   * creator wrote the options.
   */
  options_finalized_at: string | null
  /**
   * The multi-question poll this question belongs to, or null on a poll that
   * asks one question. Every question in a group shares its title,
   * description, mode and settings; the options and the ballots are its own.
   */
  group_id: string | null
  /** Where this question sits in its group, from 1. Null when it has none. */
  question_position: number | null
  /**
   * What this one question asks. The poll's title is shared across the
   * group, so this is the part that tells two questions apart. Null on a
   * poll that asks one question, which has nothing to tell apart.
   */
  question_title: string | null
}

/**
 * One question of a multi-question poll, as the question strip renders it.
 *
 * Two shapes for the two ways into a poll, and the difference is not
 * cosmetic. An invited voter is an account, so the server can say which
 * questions they have answered; a voter behind a link is a `voter_key`
 * minted separately for every question precisely so those ballots cannot be
 * joined, and `open_poll_group` will not undo that to fill in a tick. The
 * browser knows its own answers either way.
 */
export interface GroupQuestion {
  id: string
  question_position: number
  question_title: string
  /**
   * How many options this question holds. Read by the creator's "Open poll"
   * button, which applies the floor finalize_options applies -- and that is
   * a floor on every question, since opening is one act over all of them.
   */
  option_count: number
  /** Whether the signed-in reader has cast a ballot in this question. */
  voted: boolean
  /**
   * Whether they have said they are done adding options to it: the same mark
   * one stage earlier, and what the question strip draws while the poll is
   * still collecting. Optional for the reason `PollStatus.expires_at` is — a
   * browser running ahead of the migration that adds it marks nothing, which
   * is what every strip did before it existed.
   */
  confirmed?: boolean
}

/** One question of an open multi-question poll; see GroupQuestion. */
export interface OpenGroupQuestion {
  id: string
  question_position: number
  question_title: string
}

// Backed by the "candidates" table in Postgres; kept as-is there to
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
  /**
   * Still collecting options, so there is no ballot yet. Derived in the
   * database from the two columns above it; solicits options, not
   * finalized, not closed so it can never disagree with them.
   */
  soliciting: boolean
  /**
   * When the poll is deleted: six months after it was created, and nothing
   * that happens in the poll afterwards moves it; see
   * 0025_poll_retention.sql.
   *
   * Optional because this app deploys on push and its migrations apply on
   * merge, so a browser can be holding this code against a database whose
   * poll_status predates the column. A missing date says nothing rather
   * than guessing one.
   */
  expires_at?: string | null
  /**
   * Whether the signed-in reader is on this poll's invite list, which is not
   * the same as being able to read it: a creator who did not invite
   * themselves reads every word of the poll and is not one of the people it
   * is waiting on. It is what decides whether to offer them the confirm
   * button, and only the invite list can answer it.
   */
  invited?: boolean
  /** The signed-in reader has said they are done adding options. */
  confirmed?: boolean
  /**
   * How many of this question's invitees have. Not withheld on a poll that
   * hides its respondents, on the same reasoning the vote count is not: a
   * count names nobody. What that setting withholds is the roster.
   *
   * These three are optional for the same reason `expires_at` is; a browser
   * running ahead of the migration gets none of them, and the page then
   * offers no confirm button at all rather than one that cannot work.
   */
  confirmed_count?: number
  /**
   * The option this question elected, and whether the database has worked
   * that out at all.
   *
   * Two fields rather than one because there are three answers and the badge
   * draws a different thing for each: a name, *Tied* for a poll that elected
   * nobody, and *Results ready* for one whose answer this page has not been
   * told. A single nullable name could only tell two of them apart, and the
   * pair it would merge is exactly the pair that must not merge — *Tied* is a
   * wrong answer where *Results ready* is only a missing one.
   *
   * So: `winner_settled` false means not worked out; true with a null
   * `winner_name` means worked out and nobody won. Both undefined against a
   * database that predates the columns, which reads as the third case and is
   * the same reason `expires_at` is optional.
   *
   * The database settles this once, when the poll crosses into having a
   * result, and clears it when a reset takes that result away — so it arrives
   * with the read that draws the page rather than in a request behind it, and
   * a poll reset on another device cannot leave a name here that its votes no
   * longer support. See 0047_the_winner_is_kept_with_the_poll.sql.
   */
  winner_name?: string | null
  winner_settled?: boolean
}

/** One row from list_polls(): a poll and its status, fetched together. */
export interface PollListItem extends Poll, PollStatus {
  /** How many options the poll has; its turnout number while collecting. */
  option_count: number
  /**
   * How many questions the poll asks: 1 for an ordinary poll, and what the
   * count badge says in place of a turnout on a grouped one.
   *
   * The list carries the first question of a group and hides the rest, so
   * every other number on this row — the turnout, the option count — belongs
   * to that first question alone. The three that mean the whole poll are
   * `is_closed`, `is_complete` and `results_available`, which list_polls()
   * asks of every question.
   */
  question_count: number
  /**
   * How many polls the caller can see in total, not just on this page.
   *
   * Repeated on every row because a set-returning function has nowhere else
   * to put it. It is what the pager counts pages from — and the reason a page
   * of the list is one request rather than one for the rows and one for the
   * count.
   */
  total_count: number
}

export interface Invitee {
  email: string
  /** null when the poll hides respondents; show no badge, not "pending". */
  has_voted: boolean | null
  /**
   * Whether this person has said they are done adding options, which is what
   * the badge says instead of `has_voted` while the poll is still collecting
   * them: nobody can vote yet, so a row of "Pending" would be answering a
   * question the poll is not asking.
   *
   * Held back on exactly the same terms as `has_voted`, and null on the same
   * polls, because it is the same disclosure: a roster. Undefined against a
   * database whose poll_invitees predates the column.
   */
  has_confirmed?: boolean | null
}

/** Everything the public voting page needs, from one open_poll_view call. */
export interface OpenPollView {
  poll: {
    id: string
    title: string
    description: string | null
    /*
     * No created_by_email here, alone of the three views of a poll: this one
     * is read through a share link, which goes wherever it is forwarded, and
     * open_poll_view does not return the column at all.
     */
    mode: PollMode
    show_voters: boolean
    show_ballots: boolean
    solicit_options: boolean
    closed_at: string | null
    /**
     * Which multi-question poll this question belongs to, where it sits, and
     * what it asks. All three null on a poll asking one question, and all
     * three undefined against a database whose open_poll_view predates them
     * — the same reason PollStatus.expires_at is optional.
     */
    group_id?: string | null
    question_position?: number | null
    question_title?: string | null
  }
  options: PollOption[]
  voted_count: number
  is_closed: boolean
  /** Still collecting options; see PollStatus.soliciting. */
  soliciting: boolean
  results_available: boolean
  /**
   * The option this poll elected, on the same terms as `PollStatus`.
   *
   * This page has no account, so it could never ask `poll_winners()` at all:
   * its badge used to be filled in from whatever tally the results card
   * underneath it happened to fetch, which meant the badge existed only
   * because that card did and waited however long it waited. Now it arrives
   * with the page.
   */
  winner_name?: string | null
  winner_settled?: boolean
  /** This browser's voter_key has already submitted a ballot. */
  voted: boolean
  your_name: string | null
  /**
   * This browser's own scores, keyed by option id, so a voter changing their
   * mind gets their ballot back filled in without a second request. Null when
   * this voter_key has cast no ballot, and undefined against a database whose
   * open_poll_view predates the field — the same reason PollStatus.expires_at
   * is optional. Nobody else's ballot is reachable here at any stage.
   */
  your_scores?: Record<string, number> | null
  /** Names of everyone who has responded; null when the poll hides them. */
  voters: string[] | null
  /** This browser's voter_key has said it is done adding options. */
  confirmed?: boolean
  /**
   * The name it confirmed under, so the page can draw the mark back rather
   * than only the fact of it. Null on a poll that hides its respondents,
   * which stores no name whatever the client sends.
   */
  your_confirmed_name?: string | null
  /** How many browsers have confirmed; a count, so never withheld. */
  confirmed_count?: number
  /**
   * Everyone who has confirmed, by name, or null when the poll hides its
   * respondents. Unlike `voters` this carries no embargo: what the roster
   * embargo protects is the order ballots arrived in, and a poll still
   * collecting its options has no ballots to attach an order to.
   *
   * These four are optional for the reason `your_scores` is: a browser
   * talking to a database whose open_poll_view predates them reads none of
   * them, and the page then offers no confirm button rather than a broken one.
   */
  confirmations?: string[] | null
}

export interface ResultOption {
  id: string
  name: string
  /**
   * The option's description, carried out of the ballot with the tally so a
   * result stays readable once the ballot is gone. Null on nearly every
   * option, and undefined against a database whose poll_tally predates it.
   */
  description?: string | null
  total_score: number
  average_score: number
}

export interface TiebreakEntry {
  id: string
  name: string
  value: number
}

/**
 * One pair inside a tied group, and how the ballots split between them: the
 * voters who scored `a` above `b`, the voters who scored `b` above `a`, and
 * the voters who scored the two the same. Winning the matchup means being on
 * the larger of the first two numbers; the third decides nothing and is
 * reported because a reader counting heads needs it to reach the turnout.
 */
export interface Matchup {
  a: string
  a_name: string
  b: string
  b_name: string
  prefers_a: number
  prefers_b: number
  ties: number
}

/**
 * One rule tried while resolving a tie, and whether it settled it.
 *
 * A union rather than one shape with an optional field, because the pairs
 * are not an extra a head-to-head step might carry: they are what the rule
 * counted, and there is no such thing to carry for a five-star count.
 */
export type TiebreakStep = HeadToHeadStep | FiveStarStep

export interface HeadToHeadStep {
  rule: 'head_to_head'
  results: TiebreakEntry[]
  decisive: boolean
  /** Every pair in the tied group, once what `results` was counted from. */
  matchups: Matchup[]
}

export interface FiveStarStep {
  rule: 'five_star_votes'
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
  /**
   * Five-star counts for the two finalists. Always present, whether or not
   * the tie-break needed them, so a reader can check the rule that was not
   * reached as well as the one that was.
   */
  five_stars_a: number
  five_stars_b: number
  /**
   * How the runoff was settled, in the order the rules are tried:
   * 'preference' outright, then 'higher_score', then 'five_star_votes'.
   * 'unresolved' means all three were level and there is no winner.
   */
  resolved_by: 'preference' | 'higher_score' | 'five_star_votes' | 'unresolved'
}

/**
 * One place in the full ranking, which STAR produces by sequential
 * elimination: the winner steps out and the method runs again on what is
 * left. Only place 1 is what STAR itself produces.
 *
 * Fetched on its own, by `FullRanking` when somebody opens the modal, rather
 * than riding along with the tally: it costs a round per place and almost
 * nobody asks for it. `get_poll_ranking` and `open_poll_ranking` each return
 * an array of these, first place first.
 */
export interface RankingEntry {
  place: number
  /** Normally one option; two when a runoff tied on preference and score alike. */
  options: { id: string; name: string; total_score: number }[]
  /** The pair that contested this place; one id when nothing else was left. */
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
  voter_count: number
  /** Always 0 for open polls; there is no invite list. */
  invited_count: number
  mode: PollMode
  /** Closed by the creator before everyone had voted. */
  closed_early: boolean
}

/** One voter's scores, keyed by option id. */
export interface Ballot {
  /** null on a poll that hides respondents; the ballot is unattributed. */
  voter: string | null
  scores: Record<string, number>
}

/**
 * Every ballot in a poll, for auditing the tally. Only returned once the
 * results themselves have unlocked
 */
export interface BallotSheet {
  /** Mirrors the poll's show_voters: whether `voter` is filled in. */
  voters_named: boolean
  options: { id: string; name: string }[]
  /** Ordered by name, or by nothing at all when unnamed. Never by time. */
  ballots: Ballot[]
}
