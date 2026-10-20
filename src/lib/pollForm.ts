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
  MAX_OPTIONS,
  MAX_QUESTIONS,
  OPTION_DESCRIPTION_MAX,
  OPTION_NAME_MAX,
  POLL_DESCRIPTION_MAX,
  TITLE_MAX,
  tooLong,
} from './limits'
import type { DailyWindow, PollKind, PollSchedule } from './types'

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
}

let optionSeq = 0

export function blankOption(): OptionDraft {
  optionSeq += 1
  return { key: `option-${optionSeq}`, name: '', description: null }
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
  kind: PollKind
  /*
   * The time-poll fields are kept whatever the kind, so toggling a question
   * between kinds loses nothing on either side.
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
}

let questionSeq = 0

export function blankQuestion(): QuestionDraft {
  questionSeq += 1
  return {
    key: `question-${questionSeq}`,
    title: '',
    options: [blankOption(), blankOption()],
    kind: 'option',
    schedule: blankSchedule(),
    days: [],
    hours: { ...DEFAULT_HOURS },
    marked: new Set(),
    offsetPicked: false,
    datesMoved: 0,
  }
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
}

export function noErrors(): FormErrors {
  return { schedules: {}, questionTitles: {}, options: {}, optionNames: {}, optionDescriptions: {} }
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
    Object.keys(errors.optionDescriptions).length,
  )
}

/** Whether a question has anything wrong with it, for the mark on its tab. */
export function questionHasError(errors: FormErrors, questionIndex: number): boolean {
  if (
    errors.questionTitles[questionIndex] ||
    errors.options[questionIndex] ||
    errors.schedules[questionIndex]
  ) {
    return true
  }
  // The colon keeps question 1 from matching 10.
  const prefix = `${questionIndex}:`
  return (
    Object.keys(errors.optionNames).some((key) => key.startsWith(prefix)) ||
    Object.keys(errors.optionDescriptions).some((key) => key.startsWith(prefix))
  )
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

  form.questions.forEach((question, questionIndex) => {
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

    if (question.kind === 'time') {
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
