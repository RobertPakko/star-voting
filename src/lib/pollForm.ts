import {
  blankSchedule,
  countWindows,
  daysOf,
  DEFAULT_HOURS,
  describeLength,
  fromDay,
  meetingMinutes,
  spanOf,
  todayIn,
  type Bounds,
  type GranuleKey,
} from './schedule'
import {
  AMOUNT_MAX,
  GIVEN_MAX,
  MAX_CARRIED,
  MAX_OPTIONS,
  MAX_QUESTIONS,
  OPTION_DESCRIPTION_MAX,
  OPTION_NAME_MAX,
  POLL_DESCRIPTION_MAX,
  TITLE_MAX,
  tooLong,
  VOTER_NAME_MAX,
} from './limits'
import type { DailyWindow, PollKind, PollSchedule } from './types'
import { CHOICE_NUMBER, DEFAULT_CHOICE_NUMBER, isCalendar, optionNumberOf } from './choices'

/*
 * The create form's draft model and validation, apart from the page that
 * renders it.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** One option row. `description` is null when its field is hidden (no description). */
export interface OptionDraft {
  /** Stable identity so a row can animate out; never sent. */
  key: string
  name: string
  description: string | null
  /**
   * The option's number: its cost on a proportional budget question, its
   * places on an option assignment (`optionNumberOf`). What the number box
   * holds, '' while it is empty. Kept whatever the kind, like the calendar,
   * and sent only on a kind that reads one.
   */
  number: number | string
}

let optionSeq = 0

export function blankOption(): OptionDraft {
  optionSeq += 1
  return { key: `option-${optionSeq}`, name: '', description: null, number: '' }
}

/**
 * One question being written. The form always holds a list of these; a
 * single-question poll is one entry whose `title` is never read.
 */
export interface QuestionDraft {
  /** Stable identity for the tab strip; never sent. */
  key: string
  title: string
  options: OptionDraft[]
  /** What the question asks for: the form's *Choice*. */
  kind: PollKind
  /**
   * The kind's number (winners, places), kept per kind so switching between
   * them and back loses nothing. Only the chosen kind's is sent.
   */
  kindNumbers: Partial<Record<PollKind, number>>
  /** A proportional budget's budget, as the number box holds it: '' while empty. */
  budget: number | string
  /*
   * The time-poll fields are kept whatever the kind, so switching a question
   * to a list and back loses nothing on either side; so are the options.
   */
  schedule: PollSchedule
  /** The days on the calendar. Not stored. */
  days: string[]
  /** What a whole-day fill lays down. Not stored. */
  hours: DailyWindow
  /** The painted cells, which become the options. */
  marked: Set<GranuleKey>
  /** Whether the offset was chosen, or is still a guess that follows the dates. */
  offsetPicked: boolean
  /** Weeks a duplicate's dates were moved forward; 0 otherwise. */
  datesMoved: number
  /**
   * A sequential poll: `kind` is then its *Sequential poll type*, and every
   * ballot counts at the weight its voter's stars for earlier winners leave
   * it (`carried`). Kept whatever the choice, like the calendar.
   */
  sequential: boolean
  carried: CarriedDraft[]
}

/**
 * One earlier voter of a sequential question: a name (an address on an invite
 * poll) and the stars they gave the winners of earlier polls. `given` is what
 * the number box holds, '' while it is empty.
 */
export interface CarriedDraft {
  /** Stable identity for the row; never sent. */
  key: string
  voter: string
  given: number | string
}

let carriedSeq = 0

export function blankCarried(voter = '', given: number | string = ''): CarriedDraft {
  carriedSeq += 1
  return { key: `carried-${carriedSeq}`, voter, given }
}

/** Whether a row was left empty, and so is ignored rather than refused. */
const isBlankCarried = (row: CarriedDraft) => !row.voter.trim() && row.given === ''

/** The earlier voters a question sends, or null for a question that is not sequential. */
export function carriedOf(
  question: QuestionDraft,
  isOpen: boolean,
): { voter: string; given: number }[] | null {
  if (!question.sequential) return null
  return question.carried
    .filter((row) => !isBlankCarried(row))
    .map((row) => ({
      voter: isOpen ? row.voter.trim() : row.voter.trim().toLowerCase(),
      given: Number(row.given),
    }))
}

let questionSeq = 0

export function blankQuestion(): QuestionDraft {
  questionSeq += 1
  return {
    key: `question-${questionSeq}`,
    title: '',
    options: [blankOption(), blankOption()],
    kind: 'option',
    kindNumbers: { ...DEFAULT_CHOICE_NUMBER },
    budget: '',
    schedule: blankSchedule(),
    days: [],
    hours: { ...DEFAULT_HOURS },
    marked: new Set(),
    offsetPicked: false,
    datesMoved: 0,
    sequential: false,
    carried: [blankCarried()],
  }
}

/** The number a question sends with its kind: null where the kind takes none. */
export function kindValueOf(question: QuestionDraft): number | null {
  if (question.kind === 'budget') return question.budget === '' ? null : Number(question.budget)
  return CHOICE_NUMBER[question.kind] ? (question.kindNumbers[question.kind] ?? null) : null
}

/**
 * An option's number as sent: a budget's cost or an assignment's places, and
 * null while empty or on any other kind.
 */
export function numberOf(question: QuestionDraft, option: OptionDraft): number | null {
  if (!optionNumberOf(question.kind) || option.number === '') return null
  return Number(option.number)
}

/**
 * The refusal for a budget or a cost that is not a whole number from 1 to
 * `AMOUNT_MAX`, as `validate_amount` has it; null where it is one. '' is
 * empty, which the caller words.
 */
export function amountError(value: number | string): string | null {
  const n = Number(value)
  if (value === '' || !Number.isInteger(n) || n < 1 || n > AMOUNT_MAX) {
    return `A whole number from 1 to ${AMOUNT_MAX.toLocaleString('en-US')}.`
  }
  return null
}

/** Key for an option-level message: question index and row index. */
export function optionKey(question: number, option: number): string {
  return `${question}:${option}`
}

/** One message per field, keyed the way the form is laid out. */
export interface FormErrors {
  title?: string
  description?: string
  emails?: string
  /** About the list of questions as a whole. */
  questions?: string
  /** By question index. */
  schedules: Record<number, string>
  questionTitles: Record<number, string>
  options: Record<number, string>
  /** By `optionKey()`. */
  optionNames: Record<string, string>
  optionDescriptions: Record<string, string>
  /** A cost or a number of places, by `optionKey()`. */
  optionNumbers: Record<string, string>
  /** A proportional budget's budget, by question index. */
  budgets: Record<number, string>
  /** A sequential question's list of earlier voters, by question index. */
  carried: Record<number, string>
  /** One earlier voter's name and stars, by `optionKey()` (question, row). */
  carriedVoters: Record<string, string>
  carriedGiven: Record<string, string>
}

export function noErrors(): FormErrors {
  return {
    schedules: {},
    questionTitles: {},
    options: {},
    optionNames: {},
    optionDescriptions: {},
    optionNumbers: {},
    budgets: {},
    carried: {},
    carriedVoters: {},
    carriedGiven: {},
  }
}

export function hasErrors(errors: FormErrors): boolean {
  return Boolean(
    errors.title ||
    errors.description ||
    errors.emails ||
    errors.questions ||
    Object.keys(errors.schedules).length ||
    Object.keys(errors.questionTitles).length ||
    Object.keys(errors.options).length ||
    Object.keys(errors.optionNames).length ||
    Object.keys(errors.optionDescriptions).length ||
    Object.keys(errors.optionNumbers).length ||
    Object.keys(errors.budgets).length ||
    Object.keys(errors.carried).length ||
    Object.keys(errors.carriedVoters).length ||
    Object.keys(errors.carriedGiven).length,
  )
}

/** Whether a question has anything wrong with it, for the mark on its tab. */
export function questionHasError(errors: FormErrors, questionIndex: number): boolean {
  if (
    errors.questionTitles[questionIndex] ||
    errors.options[questionIndex] ||
    errors.schedules[questionIndex] ||
    errors.budgets[questionIndex] ||
    errors.carried[questionIndex]
  ) {
    return true
  }
  // The colon keeps question 1 from matching 10.
  const prefix = `${questionIndex}:`
  return (
    Object.keys(errors.optionNames).some((key) => key.startsWith(prefix)) ||
    Object.keys(errors.optionDescriptions).some((key) => key.startsWith(prefix)) ||
    Object.keys(errors.optionNumbers).some((key) => key.startsWith(prefix)) ||
    Object.keys(errors.carriedVoters).some((key) => key.startsWith(prefix)) ||
    Object.keys(errors.carriedGiven).some((key) => key.startsWith(prefix))
  )
}

/**
 * A sequential question's earlier voters. Mirrors `insert_carried_weights`:
 * named, once each, an invitee on an invite poll, with stars from 0 to
 * `GIVEN_MAX`. A row left wholly empty is ignored.
 */
function validateCarried(
  question: QuestionDraft,
  questionIndex: number,
  isOpen: boolean,
  invited: Set<string>,
  errors: FormErrors,
) {
  const rows = question.carried.filter((row) => !isBlankCarried(row))
  if (rows.length === 0) {
    errors.carried[questionIndex] = 'Add the voters from earlier polls, or choose another Choice.'
    return
  }
  if (rows.length > MAX_CARRIED) {
    errors.carried[questionIndex] =
      `A sequential poll can carry ${MAX_CARRIED} earlier voters; this one has ${rows.length}.`
  }

  const seen = new Map<string, number>()
  question.carried.forEach((row, index) => {
    if (isBlankCarried(row)) return
    const key = optionKey(questionIndex, index)
    const voter = row.voter.trim()
    const folded = voter.toLowerCase()

    if (!voter) {
      errors.carriedVoters[key] = isOpen ? 'Give this voter a name.' : 'Give this voter an email.'
    } else if (!isOpen && !EMAIL_RE.test(folded)) {
      errors.carriedVoters[key] = `"${voter}" doesn't look like an email address.`
    } else if (!isOpen && !invited.has(folded)) {
      errors.carriedVoters[key] = 'Not on the invite list above.'
    } else if (isOpen && voter.length > VOTER_NAME_MAX) {
      errors.carriedVoters[key] = tooLong('A name', voter.length, VOTER_NAME_MAX)
    } else {
      const first = seen.get(folded)
      if (first !== undefined) errors.carriedVoters[key] = `Same as voter ${first + 1}.`
      else seen.set(folded, index)
    }

    const given = row.given === '' ? NaN : Number(row.given)
    if (row.given === '') {
      errors.carriedGiven[key] = 'How many stars did they give earlier winners?'
    } else if (!Number.isFinite(given) || given < 0 || given > GIVEN_MAX) {
      errors.carriedGiven[key] = `From 0 to ${GIVEN_MAX.toLocaleString('en-US')}.`
    }
  })
}

/** The stored schedule: `window` becomes the union of what is actually painted. */
export function settle(schedule: PollSchedule, marked: Bounds): PollSchedule {
  return { ...schedule, window: spanOf(marked, schedule) }
}

/**
 * Every rule, in one pass. The page computes this each render and shows it
 * from the first submit on, so a fixed field clears as it is fixed. These
 * mirror `create_poll` and `insert_option`; the database still decides.
 */
export function validate(form: {
  title: string
  description: string
  questions: QuestionDraft[]
  multiQuestion: boolean
  emails: string[]
  includeSelf: boolean
  myEmail: string
  isOpen: boolean
  solicitOptions: boolean
}): FormErrors {
  const errors: FormErrors = noErrors()

  const title = form.title.trim()
  if (!title) errors.title = 'Give the poll a title.'
  else if (title.length > TITLE_MAX) errors.title = tooLong('A title', title.length, TITLE_MAX)

  const description = form.description.trim()
  if (description.length > POLL_DESCRIPTION_MAX) {
    errors.description = tooLong('A description', description.length, POLL_DESCRIPTION_MAX)
  }

  if (form.multiQuestion) {
    if (form.questions.length < 2) {
      errors.questions = 'A multi-question poll needs at least two questions.'
    } else if (form.questions.length > MAX_QUESTIONS) {
      errors.questions = `A poll can ask ${MAX_QUESTIONS} questions; this one asks ${form.questions.length}.`
    }
  }

  // Who an invite poll's earlier voters may be: the people it invites.
  const invited = new Set(
    [...form.emails, ...(form.includeSelf ? [form.myEmail] : [])].map((e) =>
      e.trim().toLowerCase(),
    ),
  )

  form.questions.forEach((question, questionIndex) => {
    if (question.sequential) validateCarried(question, questionIndex, form.isOpen, invited, errors)

    if (form.multiQuestion) {
      const questionTitle = question.title.trim()
      if (!questionTitle) {
        errors.questionTitles[questionIndex] = 'Give the question a title.'
      } else if (questionTitle.length > TITLE_MAX) {
        errors.questionTitles[questionIndex] = tooLong(
          'A question title',
          questionTitle.length,
          TITLE_MAX,
        )
      }
    }

    if (isCalendar(question.kind)) {
      // Counted from the same set the submit enumerates (past days dropped),
      // so the numbers quoted here match the options made.
      const marked = fromDay(question.marked, todayIn(question.schedule.timezone))
      const days = daysOf(marked)
      const total = countWindows(question.schedule, marked)
      const length = describeLength(meetingMinutes(question.schedule))

      // A question collecting its times may start empty.
      if (form.solicitOptions && total === 0) {
        if (days.length > 0) {
          errors.schedules[questionIndex] =
            `Nothing you have marked is ${length} long. Mark a longer stretch, shorten the meeting, or leave the calendar empty and let people add times themselves.`
        }
      } else if (days.length === 0) {
        errors.schedules[questionIndex] = 'Mark the times people can meet on the calendar.'
      } else if (total === 0) {
        errors.schedules[questionIndex] =
          `Nothing you have marked is ${length} long, so there are no times to choose between. Mark a longer stretch, or shorten the meeting.`
      } else if (total < 2 && !form.solicitOptions) {
        errors.schedules[questionIndex] =
          'That leaves one window to choose from. Mark more of the day, shorten the meeting, or add a day.'
      } else if (total > MAX_OPTIONS) {
        errors.schedules[questionIndex] =
          `That is ${total} windows, and a ballot can hold ${MAX_OPTIONS}. Use a longer meeting, fewer days, or a narrower part of the day.`
      }
      return
    }

    if (question.kind === 'budget') {
      const budget = amountError(question.budget)
      if (budget) {
        errors.budgets[questionIndex] = question.budget === '' ? 'Give the budget.' : budget
      }
    }

    // Duplicates are case-insensitive and only within one question.
    const seen = new Map<string, number>()
    question.options.forEach((option, index) => {
      const key = optionKey(questionIndex, index)
      const name = option.name.trim()
      if (name.length > OPTION_NAME_MAX) {
        errors.optionNames[key] = tooLong('An option name', name.length, OPTION_NAME_MAX)
      } else if (name) {
        const first = seen.get(name.toLowerCase())
        // Marked on the later row; the first keeps the name.
        if (first !== undefined) errors.optionNames[key] = `Same as option ${first + 1}.`
        else seen.set(name.toLowerCase(), index)
      }

      const optionDescription = option.description?.trim() ?? ''
      if (optionDescription.length > OPTION_DESCRIPTION_MAX) {
        errors.optionDescriptions[key] = tooLong(
          'A description',
          optionDescription.length,
          OPTION_DESCRIPTION_MAX,
        )
      }

      // Every option a budget counts has a cost; a blank row is not an
      // option. An assignment's places may be left blank, for one.
      if (question.kind === 'budget' && name) {
        const cost = amountError(option.number)
        if (cost) errors.optionNumbers[key] = option.number === '' ? 'Give it a cost.' : cost
      }
      if (question.kind === 'assignment' && name && option.number !== '') {
        const places = amountError(option.number)
        if (places) errors.optionNumbers[key] = places
      }
    })

    const filled = question.options.filter((o) => o.name.trim()).length
    // A collecting poll may start with none; the floor applies when it opens.
    if (!form.solicitOptions && filled < 2) {
      errors.options[questionIndex] = 'A question needs at least two options.'
    } else if (filled > MAX_OPTIONS) {
      errors.options[questionIndex] =
        `A ballot can only hold ${MAX_OPTIONS} options; this one has ${filled}.`
    }
  })

  if (!form.isOpen) {
    const typed = form.emails.map((e) => e.trim().toLowerCase()).filter(Boolean)
    const invalid = typed.filter((e) => !EMAIL_RE.test(e))
    if (invalid.length) {
      errors.emails =
        invalid.length === 1
          ? `"${invalid[0]}" doesn't look like an email address.`
          : `These don't look like email addresses: ${invalid.join(', ')}.`
    } else {
      // The tag input refuses exact repeats, but not ones differing in case.
      const repeated = typed.filter((e, i) => typed.indexOf(e) !== i)
      if (repeated.length) {
        errors.emails = `${repeated[0]} is on the list twice.`
      } else if (form.includeSelf && typed.includes(form.myEmail)) {
        errors.emails = `You're invited by the checkbox below; remove ${form.myEmail} from the list, or untick it.`
      } else if (typed.length === 0 && !form.includeSelf) {
        errors.emails = 'Invite at least one voter, or include yourself.'
      }
    }
  }

  return errors
}
