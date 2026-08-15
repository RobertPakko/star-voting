export interface Poll {
  id: string
  title: string
  description: string | null
  created_by: string
  created_by_email: string
  created_at: string
  closed_at: string | null
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
  has_voted: boolean
}

export interface ResultOption {
  id: string
  name: string
  total_score: number
  average_score: number
}

export interface PollResults {
  options: ResultOption[]
  finalists: string[]
  tie: boolean
  runoff: {
    prefers_a: number
    prefers_b: number
    ties: number
  } | null
  winner_id: string | null
  voter_count: number
  invited_count: number
  /** Closed by the creator before everyone had voted. */
  closed_early: boolean
}
