import type { ConsensusResult, FractionalShare, PollKind, PollResults, RankingEntry } from './types'
import { SCORING_ROWS_MAX } from './resultsRows'

/**
 * What a question can ask for, named once for the create form's *Choice*,
 * the results and the *More results* menu. Stored as `polls.kind`: the two
 * time kinds (`isCalendar`) change the ballot to a calendar, every other
 * kind is a written list, and each opens its results on its own answer.
 * Several best times are a time poll's *More results*, not a kind of their
 * own.
 */
export const CHOICES: Record<PollKind, { label: string }> = {
  option: { label: 'Best option' },
  time: { label: 'Best time' },
  ranking: { label: 'Option ranking' },
  multiple: { label: 'Multiple winners' },
  fractional: { label: 'Fractional winners' },
  consensus: { label: 'Consensus option' },
  consensus_time: { label: 'Consensus time' },
}

/**
 * Whether a kind's ballot is a calendar: its options are the starts of
 * meeting windows and it carries a schedule. Ask this rather than
 * `kind === 'time'`, which misses the consensus time.
 */
export const isCalendar = (kind: PollKind) => kind === 'time' || kind === 'consensus_time'

/** In the order the create form offers them. */
export const CHOICE_ORDER: PollKind[] = [
  'option',
  'time',
  'consensus',
  'consensus_time',
  'ranking',
  'multiple',
  'fractional',
]

/** The results a tally can offer beside STAR's own answer, each a modal. */
export type ResultTool = Extract<PollKind, 'ranking' | 'multiple' | 'fractional' | 'consensus'>

/** A result tool's name on a poll of this kind: a time poll's consensus is a time. */
export const toolLabel = (tool: ResultTool, kind: PollKind) =>
  tool === 'consensus' && isCalendar(kind) ? CHOICES.consensus_time.label : CHOICES[tool].label

/**
 * What a kind's number (`kind_value`) counts, for the kinds that take one.
 * The database holds it to 2 – `SCORING_ROWS_MAX` (`validate_kind`).
 */
export const CHOICE_NUMBER: Partial<Record<PollKind, { label: string }>> = {
  ranking: { label: 'Places to rank' },
  multiple: { label: 'Number of winners' },
}

/** Every number a kind may take, smallest first. */
export const CHOICE_NUMBERS = Array.from({ length: SCORING_ROWS_MAX - 1 }, (_, i) => i + 2)

/** What a fresh question's number starts at, for the kinds that take one. */
export const DEFAULT_CHOICE_NUMBER: Partial<Record<PollKind, number>> = {
  ranking: SCORING_ROWS_MAX,
  multiple: 3,
}

/**
 * Which results a tally is offered, from the option count it already
 * carries, so nothing waits on a request to find out. With two options the
 * ranking is the winner and the option it beat, and choosing more than one
 * winner is choosing both; how to split between two is still a question, and
 * so is the consensus between two, which need not be STAR's winner.
 * `poll_tally` applies the same floors to the result it carries.
 */
export function offers(tool: ResultTool, results: PollResults) {
  return tool === 'fractional' || tool === 'consensus'
    ? results.option_count >= 2
    : results.option_count >= 3
}

export type ChosenResult =
  | { kind: 'ranking' | 'multiple'; entries: RankingEntry[] }
  | { kind: 'fractional'; shares: FractionalShare[] }
  | { kind: 'consensus'; consensus: ConsensusResult }

/**
 * The result a tally opens on, where the question asked for more than STAR's
 * winner. Null for the best option or time, or where the poll is too small
 * for its kind (`poll_tally` then carries none), and the page shows the
 * winner.
 */
export function chosenResult(results: PollResults): ChosenResult | null {
  const { kind, kind_result: result } = results
  if (!result) return null
  if (kind === 'consensus' || kind === 'consensus_time') {
    return !Array.isArray(result) ? { kind: 'consensus', consensus: result } : null
  }
  if (!Array.isArray(result)) return null
  if (kind === 'fractional') {
    return result.every((r) => 'share' in r) ? { kind, shares: result as FractionalShare[] } : null
  }
  if (kind === 'ranking' || kind === 'multiple') {
    return result.every((r) => 'place' in r) ? { kind, entries: result as RankingEntry[] } : null
  }
  return null
}

/**
 * A ranking or a set of winners cut to the reader's number: every place up
 * to it, a shared place kept whole. Null keeps everything.
 */
export const cutTo = (entries: RankingEntry[], places: number | null) =>
  places === null ? entries : entries.filter((entry) => entry.place <= places)
