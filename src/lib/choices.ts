import type {
  AssignmentResult,
  BudgetResult,
  ConsensusResult,
  ConsensusWinnersResult,
  FractionalShare,
  PollKind,
  PollResults,
  RankingEntry,
} from './types'
import { SCORING_ROWS_MAX } from './resultsRows'

/**
 * What a question can ask for, named once for the create form's *Choice*,
 * the results and the *More results* menu. Stored as `polls.kind`: the
 * three time kinds (`isCalendar`) change the ballot to a calendar, every other
 * kind is a written list, and each opens its results on its own answer.
 * Several best times are a time poll's *More results*, not a kind of their
 * own.
 */
export const CHOICES: Record<PollKind, { label: string; section: string; blurb: string }> = {
  option: { label: 'Best option', section: 'best-option', blurb: 'picks one option using STAR.' },
  time: { label: 'Best time', section: 'best-option', blurb: 'picks one time using STAR.' },
  ranking: {
    label: 'Option ranking',
    section: 'option-ranking',
    blurb: 'puts every option in order by running STAR again without the winner.',
  },
  multiple: {
    label: 'Multiple winners',
    section: 'multiple-winners',
    blurb:
      'gives a ranking that shares top spots so that different groups of voters each get something they like.',
  },
  fractional: {
    label: 'Fractional winners',
    section: 'fractional-winners',
    blurb: 'computes the fairest split of options when it’s possible to take a little of each.',
  },
  consensus: {
    label: 'Consensus option',
    section: 'consensus-option',
    blurb: 'picks the option whose worst score is as good as possible.',
  },
  consensus_time: {
    label: 'Consensus time',
    section: 'consensus-option',
    blurb: 'picks the time whose worst score is as good as possible.',
  },
  consensus_winners: {
    label: 'Consensus winners',
    section: 'consensus-winners',
    blurb:
      'picks several options together so that the voter they serve worst is served as well as possible.',
  },
  consensus_times: {
    label: 'Consensus times',
    section: 'consensus-winners',
    blurb:
      'picks several times together so that everybody can make at least one of them as comfortably as possible.',
  },
  budget: {
    label: 'Proportional budget',
    section: 'proportional-budget',
    blurb:
      'shares a budget between options of differing costs so that different groups of voters each get something they like.',
  },
  assignment: {
    label: 'Option assignment',
    section: 'option-assignment',
    blurb:
      'gives each voter one or more options, each option going to as many voters as it has places, so that the group as a whole is as satisfied as it can be.',
  },
}

/**
 * The number an option of a kind carries beside its name, and its field when
 * sent and read: a budget's cost (required), an assignment's places (none
 * meaning one). Both are `candidates.kind_value`. Null for every other kind.
 */
export type OptionNumber = 'cost' | 'places'

export const optionNumberOf = (kind: PollKind): OptionNumber | null =>
  kind === 'budget' ? 'cost' : kind === 'assignment' ? 'places' : null

/** Where `/choices` explains a kind; each `section` is one of its card ids. */
export const choicePage = (kind: PollKind) => `/choices?section=${CHOICES[kind].section}`

/**
 * Whether a kind's ballot is a calendar: its options are the starts of
 * meeting windows and it carries a schedule. Ask this rather than
 * `kind === 'time'`, which misses the consensus kinds. `is_calendar_kind`
 * holds the same list in the database.
 */
export const isCalendar = (kind: PollKind) =>
  kind === 'time' || kind === 'consensus_time' || kind === 'consensus_times'

/**
 * The kinds a sequential poll can be: the results STAR decides, which count
 * each ballot at its weight. `insert_carried_weights` holds the same list.
 */
export const SEQUENTIAL_KINDS: PollKind[] = ['option', 'time', 'ranking', 'multiple']

/** In the order the create form offers them. */
export const CHOICE_ORDER: PollKind[] = [
  'option',
  'time',
  'consensus',
  'consensus_time',
  'consensus_winners',
  'consensus_times',
  'ranking',
  'multiple',
  'fractional',
  'budget',
  'assignment',
]

/**
 * The results a tally can offer, each a modal where it is not the one the
 * page opens on. `option` is STAR's own answer: the winner, the runoff and
 * the scoring round.
 */
export type ResultTool = Extract<
  PollKind,
  | 'option'
  | 'ranking'
  | 'multiple'
  | 'fractional'
  | 'consensus'
  | 'consensus_winners'
  | 'budget'
  | 'assignment'
>

/** The kind a tool is on a poll of this kind: on a calendar, an option is a time. */
export function toolKind(tool: ResultTool, kind: PollKind): PollKind {
  if (!isCalendar(kind)) return tool
  if (tool === 'option') return 'time'
  if (tool === 'consensus') return 'consensus_time'
  if (tool === 'consensus_winners') return 'consensus_times'
  return tool
}

/** A result tool's name on a poll of this kind: a time poll's consensus is a time. */
export const toolLabel = (tool: ResultTool, kind: PollKind) => CHOICES[toolKind(tool, kind)].label

/** Every number a ranking or several winners (of either kind) may take, smallest first. */
export const CHOICE_NUMBERS = Array.from({ length: SCORING_ROWS_MAX - 1 }, (_, i) => i + 2)

/** Every number of options an assignment may give one voter, smallest first. */
export const PER_VOTER_NUMBERS = Array.from({ length: SCORING_ROWS_MAX }, (_, i) => i + 1)

/**
 * What a kind's number (`kind_value`) counts, for the kinds that take one
 * from a dropdown, and the numbers it offers. The database holds a ranking
 * or several winners to 2 – `SCORING_ROWS_MAX` and an assignment to
 * 1 – `SCORING_ROWS_MAX` (`validate_kind`). Consensus winners must have one;
 * the others may be left at *All* (null).
 */
export const CHOICE_NUMBER: Partial<Record<PollKind, { label: string; numbers: number[] }>> = {
  ranking: { label: 'Places to rank', numbers: CHOICE_NUMBERS },
  multiple: { label: 'Number of winners', numbers: CHOICE_NUMBERS },
  consensus_winners: { label: 'Number of winners', numbers: CHOICE_NUMBERS },
  consensus_times: { label: 'Number of times', numbers: CHOICE_NUMBERS },
  assignment: { label: 'Max options per voter', numbers: PER_VOTER_NUMBERS },
}

/** What a fresh question's number starts at, for the kinds that take one. */
export const DEFAULT_CHOICE_NUMBER: Partial<Record<PollKind, number>> = {
  ranking: SCORING_ROWS_MAX,
  multiple: 3,
  consensus_winners: 3,
  consensus_times: 3,
  assignment: 1,
}

/**
 * How many consensus winners a count opens on where the question did not say
 * (a *More results* modal on another kind): the default, but always fewer
 * than the options, since choosing all of them is no choice. The sample
 * records the same number (`scripts/sample-poll.sql`).
 */
export const consensusWinnersFor = (results: PollResults) =>
  (results.kind === 'consensus_winners' || results.kind === 'consensus_times') &&
  results.kind_value !== null
    ? results.kind_value
    : Math.max(2, Math.min(DEFAULT_CHOICE_NUMBER.consensus_winners!, results.option_count - 1))

/**
 * Which results a tally is offered, from the option count it already
 * carries, so nothing waits on a request to find out. With two options the
 * ranking is the winner and the option it beat, and choosing more than one
 * winner is choosing both; how to split between two is still a question, and
 * so is the consensus between two, which need not be STAR's winner.
 * `poll_tally` applies the same floors to the result it carries.
 */
export function offers(tool: ResultTool, results: PollResults) {
  if (tool === 'option') return true
  // A sequential poll's ballots carry weights, which only STAR's results
  // count with; a consensus or a split of them would quietly ignore them.
  if (results.weighted && !SEQUENTIAL_KINDS.includes(tool)) return false
  // A calendar's windows are not things anybody buys, or is handed.
  if ((tool === 'budget' || tool === 'assignment') && isCalendar(results.kind)) return false
  // An assignment says who gets what, so it needs a poll that names its voters.
  if (tool === 'assignment' && !results.voters_shown) return false
  return tool === 'fractional' || tool === 'consensus' || tool === 'budget' || tool === 'assignment'
    ? results.option_count >= 2
    : results.option_count >= 3
}

export type ChosenResult =
  | { kind: 'ranking' | 'multiple'; entries: RankingEntry[] }
  | { kind: 'fractional'; shares: FractionalShare[] }
  | { kind: 'consensus'; consensus: ConsensusResult }
  | { kind: 'consensus_winners'; winners: ConsensusWinnersResult }
  | { kind: 'budget'; budget: BudgetResult }
  | { kind: 'assignment'; assignment: AssignmentResult }

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
    return !Array.isArray(result) && 'tied_count' in result
      ? { kind: 'consensus', consensus: result }
      : null
  }
  if (kind === 'consensus_winners' || kind === 'consensus_times') {
    return !Array.isArray(result) && 'served' in result
      ? { kind: 'consensus_winners', winners: result }
      : null
  }
  if (kind === 'budget') {
    return !Array.isArray(result) && 'spots' in result ? { kind, budget: result } : null
  }
  if (kind === 'assignment') {
    return !Array.isArray(result) && 'unplaced' in result ? { kind, assignment: result } : null
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
