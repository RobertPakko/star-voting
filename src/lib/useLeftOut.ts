import { useState } from 'react'
import type { LeftOut } from '../components/RemovedOptions'

/**
 * The options a reader has taken out of a count (*Multiple winners*,
 * *Fractional winners*), for one poll: another poll's removals mean nothing,
 * so a new poll starts with none. Held by whoever outlives the count's body —
 * the modal's wrapper, or the results page — so closing the modal loses
 * nothing.
 */
export function useLeftOut(pollId: string) {
  const [leftOut, setLeftOut] = useState<LeftOut[]>([])
  const [leftOutFor, setLeftOutFor] = useState(pollId)
  if (leftOutFor !== pollId) {
    setLeftOutFor(pollId)
    setLeftOut([])
  }
  return [leftOut, setLeftOut] as const
}

/**
 * Costs and a budget a reader has typed into *Proportional budget*, sent with
 * every count and never stored. Null counts the question's own (a budget
 * question has them; any other has none, and asks for them first). A cost of
 * null takes that option's cost away, leaving it out of the count.
 */
export interface BudgetInputs {
  costs: Record<string, number | null>
  budget: number
}

/**
 * What a reader has typed into *Option assignment*, sent with every count and
 * never stored: each option's places (null for one place) and the most
 * options a voter is given. Null as a whole counts the question's own.
 */
export interface AssignmentInputs {
  places: Record<string, number | null>
  perVoter: number
}

/** The reader's places and cap for one poll, held as `useLeftOut` holds removals. */
export function useAssignmentInputs(pollId: string) {
  const [inputs, setInputs] = useState<AssignmentInputs | null>(null)
  const [inputsFor, setInputsFor] = useState(pollId)
  if (inputsFor !== pollId) {
    setInputsFor(pollId)
    setInputs(null)
  }
  return [inputs, setInputs] as const
}

/** The reader's costs and budget for one poll, held as `useLeftOut` holds removals. */
export function useBudgetInputs(pollId: string) {
  const [inputs, setInputs] = useState<BudgetInputs | null>(null)
  const [inputsFor, setInputsFor] = useState(pollId)
  if (inputsFor !== pollId) {
    setInputsFor(pollId)
    setInputs(null)
  }
  return [inputs, setInputs] as const
}
