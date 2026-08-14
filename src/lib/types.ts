export interface Poll {
  id: string
  title: string
  description: string | null
  created_by: string
  created_at: string
}

export interface Candidate {
  id: string
  poll_id: string
  name: string
  description: string | null
  sort_order: number
}

export interface PollStatus {
  invited_count: number
  voted_count: number
  is_complete: boolean
  voted: boolean
}

export interface ResultCandidate {
  id: string
  name: string
  total_score: number
  average_score: number
}

export interface PollResults {
  candidates: ResultCandidate[]
  finalists: string[]
  tie: boolean
  runoff: {
    prefers_a: number
    prefers_b: number
    ties: number
  } | null
  winner_id: string | null
}
