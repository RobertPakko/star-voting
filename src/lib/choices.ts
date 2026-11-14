import type {
  AssignmentResult,
  BudgetResult,
  FractionalBudgetResult,
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
 * the results and the *More results* menu. Stored as `polls.kind`, and each
 * opens its results on its own answer. On top of its choice a question may
 * take one variant (`Variant`): a calendar, a sequence or a budget. A
 * calendar is the question's schedule and a sequence its carried voters, but
 * a budget changes the count, so each choice that takes one has a stored kind
 * of its own: `ranking_budget`, `budget` and `fractional_budget`
 * (`budgetKindOf`). On a calendar
 * the kinds a meeting time is most often asked for read as times
 * (`CALENDAR_NAMES`).
 */
export const CHOICES: Record<PollKind, { label: string; section: string; blurb: string }> = {
  option: { label: 'Best option', section: 'best-option', blurb: 'picks one option using STAR.' },
  ranking: {
    label: 'Multiple winners',
    section: 'multiple-winners',
    blurb:
      'picks several winners by running STAR again and again without the options already chosen.',
  },
  multiple: {
    label: 'Proportional winners',
    section: 'proportional-winners',
    blurb: 'picks several winners so that different groups of voters each get something they like.',
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
  consensus_winners: {
    label: 'Consensus winners',
    section: 'consensus-winners',
    blurb:
      'picks several options together so that the voter they serve worst is served as well as possible.',
  },
  budget: {
    label: 'Proportional winners with a budget',
    section: 'proportional-winners',
    blurb:
      'picks winners of differing costs until the budget runs out, so that different groups of voters each get something they like.',
  },
  ranking_budget: {
    label: 'Multiple winners with a budget',
    section: 'multiple-winners',
    blurb:
      'picks winners of differing costs by running STAR again and again until the budget runs out.',
  },
  fractional_budget: {
    label: 'Fractional winners with a budget',
    section: 'fractional-winners',
    blurb:
      'funds options of differing costs in part, up to what each costs, so that the budget is split as fairly as it can be.',
  },
  assignment: {
    label: 'Option assignment',
    section: 'option-assignment',
    blurb:
      'gives each voter one or more options, each option going to as many voters as it has places, so that the group as a whole is as satisfied as it can be.',
  },
}

/** What a kind is called on a calendar, where it reads as a time rather than an option. */
const CALENDAR_NAMES: Partial<Record<PollKind, { label: string; blurb: string }>> = {
  option: { label: 'Best time', blurb: 'picks one time using STAR.' },
  consensus: {
    label: 'Consensus time',
    blurb: 'picks the time whose worst score is as good as possible.',
  },
  consensus_winners: {
    label: 'Consensus times',
    blurb:
      'picks several times together so that everybody can make at least one of them as comfortably as possible.',
  },
  assignment: {
    label: 'Time assignment',
    blurb:
      'gives each voter one or more times, each time going to as many voters as it has places, so that the group as a whole is as satisfied as it can be.',
  },
}

/** A kind's name and sentence, as times where the options are a calendar's. */
export function choiceOf(kind: PollKind, calendar: boolean) {
  return { ...CHOICES[kind], ...(calendar ? CALENDAR_NAMES[kind] : undefined) }
}

/** A kind's name, as a time where the options are a calendar's. */
export const choiceLabel = (kind: PollKind, calendar: boolean) => choiceOf(kind, calendar).label

/**
 * The number an option of a kind carries beside its name, and its field when
 * sent and read: a budget's cost (required), an assignment's places (none
 * meaning one). Both are `candidates.kind_value`. Null for every other kind.
 */
export type OptionNumber = 'cost' | 'places'

export const optionNumberOf = (kind: PollKind): OptionNumber | null =>
  isBudgetKind(kind) ? 'cost' : kind === 'assignment' ? 'places' : null

/** Where `/choices` explains a kind; each `section` is one of its card ids. */
export const choicePage = (kind: PollKind) =>
  isBudgetKind(kind) ? variantPage('budget') : `/choices?section=${CHOICES[kind].section}`

/** Whether a kind is a choice counted against a budget: its options carry costs. */
export const isBudgetKind = (kind: PollKind) =>
  kind === 'budget' || kind === 'ranking_budget' || kind === 'fractional_budget'

/**
 * What a question can be asked for on the create form: every kind but the
 * budgeted ones, which are a choice with the budget variant.
 */
export type Choice = Exclude<PollKind, 'budget' | 'ranking_budget' | 'fractional_budget'>

/** The choice a stored kind is, with the budget taken off. */
export const choiceOfKind = (kind: PollKind): Choice =>
  kind === 'budget'
    ? 'multiple'
    : kind === 'ranking_budget'
      ? 'ranking'
      : kind === 'fractional_budget'
        ? 'fractional'
        : kind

/** The kind a choice is stored as with a budget. */
export const budgetKindOf = (choice: Choice): PollKind =>
  choice === 'ranking' ? 'ranking_budget' : choice === 'fractional' ? 'fractional_budget' : 'budget'

/**
 * The counts a budget can be shared out by, each a choice: `p_choice` on
 * `get_poll_budget` / `open_poll_budget`. In the order the *Budget variant*
 * offers them.
 */
export type BudgetCount = 'ranking' | 'multiple' | 'fractional'

export const BUDGET_COUNTS: BudgetCount[] = ['ranking', 'multiple', 'fractional']

/**
 * The count a question's budget runs: a budget question's own, else
 * proportional winners, where the *Budget variant* starts.
 */
export const budgetCountOf = (kind: PollKind): BudgetCount =>
  kind === 'ranking_budget' ? 'ranking' : kind === 'fractional_budget' ? 'fractional' : 'multiple'

/**
 * What a question may take on top of its choice, one at most: its options are
 * the windows of a painted calendar, its ballots are weighted by what their
 * voters won in earlier polls, or its options cost something and the winners
 * are bought out of a budget. The database holds the same rule
 * (`validate_calendar_kind`, `insert_carried_weights`).
 */
export type Variant = 'time' | 'sequential' | 'budget'

/** In the order the create form offers them, after *None*. */
export const VARIANT_ORDER: Variant[] = ['time', 'sequential', 'budget']

/** What each variant is called, and where `/variants` explains it. */
export const VARIANTS: Record<Variant, { label: string; section: string; blurb: string }> = {
  time: {
    label: 'Time poll',
    section: 'time-polls',
    blurb: 'has voters mark a calendar, so that every option is a time the meeting could start.',
  },
  sequential: {
    label: 'Sequential poll',
    section: 'sequential-polls',
    blurb:
      'weighs each ballot by what its voter got from earlier polls, so that over a run of polls everybody gets a turn.',
  },
  budget: {
    label: 'Budget poll',
    section: 'budget-polls',
    blurb: 'gives every option a cost and spends a budget on them, until it runs out.',
  },
}

/** Where `/variants` explains a variant. */
export const variantPage = (variant: Variant) => `/variants?section=${VARIANTS[variant].section}`

/**
 * Whether a choice may take a variant. Any may be a calendar; only what STAR
 * decides can weigh its ballots (`SEQUENTIAL_KINDS`); and only a choice of
 * several winners, or a split, can spend a budget.
 */
export function variantAllowed(variant: Variant, choice: Choice): boolean {
  if (variant === 'time') return true
  if (variant === 'sequential') return SEQUENTIAL_KINDS.includes(choice)
  return choice === 'ranking' || choice === 'multiple' || choice === 'fractional'
}

/**
 * Whether a kind may be asked of a calendar: every one but a budget, whose
 * options are bought, which a meeting time is not. `validate_calendar_kind`
 * holds the same rule.
 */
export const canBeCalendar = (kind: PollKind) => !isBudgetKind(kind)

/**
 * Whether a kind picks several times at once, so that windows overlapping
 * one another would make two of its answers nearly the same time. Their
 * windows start back to back unless the creator says otherwise (`defaultStep`).
 */
export const picksSeveral = (kind: PollKind) =>
  kind === 'ranking' ||
  kind === 'multiple' ||
  kind === 'consensus_winners' ||
  kind === 'fractional' ||
  kind === 'assignment'

/**
 * The kinds a sequential poll can be: the results STAR decides, which count
 * each ballot at its weight. `insert_carried_weights` holds the same list.
 */
export const SEQUENTIAL_KINDS: PollKind[] = ['option', 'ranking', 'multiple']

/** In the order the create form offers them. */
export const CHOICE_ORDER: Choice[] = [
  'option',
  'consensus',
  'consensus_winners',
  'ranking',
  'multiple',
  'fractional',
  'assignment',
]

/**
 * The results a tally can offer, each a modal where it is not the one the
 * page opens on. `option` is STAR's own answer: the winner, the runoff and
 * the scoring round. The two variants are counts the reader sets up: a budget
 * with costs they type, or weights for every ballot of a published sheet.
 */
export type ResultTool = Choice | 'budget_variant' | 'sequential_variant'

/** A result tool's name on a poll whose options are, or are not, a calendar's. */
export const toolLabel = (tool: ResultTool, calendar: boolean) =>
  tool === 'budget_variant'
    ? 'Budget variant'
    : tool === 'sequential_variant'
      ? 'Sequential variant'
      : choiceLabel(tool, calendar)

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
  ranking: { label: 'Number of winners', numbers: CHOICE_NUMBERS },
  multiple: { label: 'Number of winners', numbers: CHOICE_NUMBERS },
  consensus_winners: { label: 'Number of winners', numbers: CHOICE_NUMBERS },
  assignment: { label: 'Max options per voter', numbers: PER_VOTER_NUMBERS },
}

/** What a kind's number is called on a calendar, where its options are times. */
const CALENDAR_NUMBER_LABELS: Partial<Record<PollKind, string>> = {
  ranking: 'Number of winning times',
  multiple: 'Number of winning times',
  consensus_winners: 'Number of times',
  assignment: 'Max times per voter',
}

/** `CHOICE_NUMBER`'s label for a kind, as times where the options are a calendar's. */
export const choiceNumberLabel = (kind: PollKind, calendar: boolean) =>
  (calendar ? CALENDAR_NUMBER_LABELS[kind] : undefined) ?? CHOICE_NUMBER[kind]?.label ?? ''

/** What a fresh question's number starts at, for the kinds that take one. */
export const DEFAULT_CHOICE_NUMBER: Partial<Record<PollKind, number>> = {
  ranking: 3,
  multiple: 3,
  consensus_winners: 3,
  assignment: 1,
}

/**
 * How many consensus winners a count opens on where the question did not say
 * (a *More results* modal on another kind): the default, but always fewer
 * than the options, since choosing all of them is no choice. The sample
 * records the same number (`scripts/sample-poll.sql`).
 */
export const consensusWinnersFor = (results: PollResults) =>
  results.kind === 'consensus_winners' && results.kind_value !== null
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
  // A question takes one variant at most, so neither is offered on a
  // calendar or on a question that already has one.
  if (tool === 'budget_variant' || tool === 'sequential_variant') {
    if (results.calendar || results.weighted || isBudgetKind(results.kind)) return false
    if (results.option_count < 2) return false
    // Weighing a ballot by its voter discloses nothing only where the sheet
    // already shows every ballot with a name on it (`poll_sequential`).
    return (
      tool === 'budget_variant' || (results.voters_shown === true && results.ballots_shown === true)
    )
  }
  // A sequential poll's ballots carry weights, which only STAR's results
  // count with; a consensus or a split of them would quietly ignore them.
  if (results.weighted && !SEQUENTIAL_KINDS.includes(tool)) return false
  // An assignment says who gets what, so it needs a poll that names its voters.
  if (tool === 'assignment' && !results.voters_shown) return false
  return tool === 'fractional' || tool === 'consensus' || tool === 'assignment'
    ? results.option_count >= 2
    : results.option_count >= 3
}

export type ChosenResult =
  | { kind: 'ranking' | 'multiple'; entries: RankingEntry[] }
  | { kind: 'fractional'; shares: FractionalShare[] }
  | { kind: 'consensus'; consensus: ConsensusResult }
  | { kind: 'consensus_winners'; winners: ConsensusWinnersResult }
  | { kind: 'budget' | 'ranking_budget'; budget: BudgetResult }
  | { kind: 'fractional_budget'; budget: FractionalBudgetResult }
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
  if (kind === 'consensus') {
    return !Array.isArray(result) && 'tied_count' in result
      ? { kind: 'consensus', consensus: result }
      : null
  }
  if (kind === 'consensus_winners') {
    return !Array.isArray(result) && 'served' in result
      ? { kind: 'consensus_winners', winners: result }
      : null
  }
  if (kind === 'budget' || kind === 'ranking_budget') {
    return !Array.isArray(result) && 'spots' in result ? { kind, budget: result } : null
  }
  if (kind === 'fractional_budget') {
    return !Array.isArray(result) && 'outside' in result ? { kind, budget: result } : null
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
