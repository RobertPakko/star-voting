import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  ActionIcon,
  Alert,
  Button,
  Card,
  Checkbox,
  Group,
  SegmentedControl,
  Stack,
  Switch,
  Tabs,
  TagsInput,
  Text,
  Textarea,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { useAuth } from '../lib/auth'
import { supabase } from '../lib/supabase'
import { DescriptionField } from '../components/DescriptionField'
import { ScheduleFields } from '../components/ScheduleFields'
import {
  blankSchedule,
  boundsOf,
  carryForward,
  countWindows,
  daysOf,
  DEFAULT_HOURS,
  describeLength,
  enumerateWindows,
  meetingMinutes,
  spanOf,
  type Bounds,
  type GranuleKey,
} from '../lib/schedule'
import { viewerOffsetOn } from '../lib/timezones'
import { pollScheduleSchema } from '../lib/rpcSchemas'
import { FormSkeleton } from '../components/Skeletons'
import styles from './CreatePoll.module.css'
import listRow from '../components/listRow.module.css'
import {
  MAX_OPTIONS,
  MAX_QUESTIONS,
  OPTION_DESCRIPTION_MAX,
  OPTION_NAME_MAX,
  POLL_DESCRIPTION_MAX,
  TITLE_MAX,
  tooLong,
} from '../lib/limits'
import type {
  DailyWindow,
  Invitee,
  Poll,
  PollKind,
  PollMode,
  PollOption,
  PollSchedule,
} from '../lib/types'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * One row of the options list. `description` is null when the option has no
 * description field on screen at all, which is the state nearly every option
 * in nearly every poll stays in.
 */
interface OptionDraft {
  /**
   * Identity, for exactly the reason `QuestionDraft` has one. The rows were
   * keyed by position, which React is happy with right up to the moment a row
   * leaves: removing option 2 of four slides 3 and 4 up one, and every row
   * below the gap is then a different option wearing the same key — which is
   * fine for text in a box and not fine at all for a row that is supposed to
   * be animating its way out. The messages under the fields stay keyed by
   * position, and deliberately: they are about *option 3*, which is a place
   * in a list rather than a thing.
   *
   * Never sent anywhere; the options travel to the database in order.
   */
  key: string
  name: string
  description: string | null
}

/** Only has to be unique within one open form, and never leaves it. */
let optionSeq = 0

function blankOption(): OptionDraft {
  optionSeq += 1
  return { key: `option-${optionSeq}`, name: '', description: null }
}

/**
 * One question of the poll being written: what it asks, and what it offers.
 *
 * The form holds a list of these whether or not the poll asks more than one,
 * so that every rule about an option list is written once and applied to
 * every list there is. A single-question poll is one entry whose `title` is
 * never read; turning the switch on is what starts reading it.
 */
interface QuestionDraft {
  /**
   * Identity, so the tab strip can point at a question rather than at a
   * position. Index would do for rendering and does not do for selection:
   * removing question 2 of four slides 3 and 4 down one, and a tab holding
   * the number would silently be looking at a different question afterwards.
   * Never sent anywhere — `create_poll_group` takes the questions in order.
   */
  key: string
  title: string
  options: OptionDraft[]
  /**
   * What *this* question is choosing between, which used to be one answer for
   * the whole poll. It is per question now because a group may ask "what are
   * we watching?" and "when?", and `create_poll_group` reads a kind off each
   * question — see 0056.
   */
  kind: PollKind
  /**
   * The four everything below is drafted from. All of them are held whether or
   * not the question is a time poll, so switching a question back and forth
   * does not throw away what was painted on the other side of the toggle —
   * exactly as the option rows survive the same switch.
   */
  schedule: PollSchedule
  /** The days on the calendar. Not stored; see PollSchedule. */
  days: string[]
  /** The hours a whole-day fill lays down. Not stored either. */
  hours: DailyWindow
  /** The cells painted in bounds, which become this question's options. */
  marked: Set<GranuleKey>
  /**
   * Whether the offset on the schedule is an answer or a guess. Until the
   * creator picks one it is wherever this browser is, and it follows the
   * question's dates; see `pickDays`.
   */
  offsetPicked: boolean
  /**
   * How many weeks a duplicate's dates had to move to stop being in the past;
   * 0 on every other question, and cleared the moment the creator picks a day
   * of their own. See `carryForward`.
   */
  datesMoved: number
}

/** Only has to be unique within one open form, and never leaves it. */
let questionSeq = 0

/**
 * The value of the `+` tab, which adds a question rather than opening one.
 *
 * A tab and not a button under the strip: adding a question *is* adding a
 * tab, and the row of tabs is where a reader is already looking to see how
 * many there are. It cannot collide with a question — those are keyed
 * `question-N` — so the one `onChange` can tell "open this" from "make
 * another" by the value alone.
 */
const ADD_QUESTION = 'add-question'

function blankQuestion(): QuestionDraft {
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

/**
 * Which question an option-level message belongs to, since the fields are a
 * list inside a list. A single-question poll never sees the difference: its
 * one question is index 0 and its rows key off that like any other.
 */
function optionKey(question: number, option: number): string {
  return `${question}:${option}`
}

/**
 * Whether one question has anything wrong with it, for the mark on its tab.
 * Its own title, its option list as a whole, or any field in it — a tab is
 * the only thing on screen for a question that isn't, so it has to answer for
 * all three.
 *
 * Takes the errors rather than reading the ones being rendered, because it is
 * asked twice and the two askers hold different sets: the tab strip asks
 * about the messages on screen, and the submit that has just failed asks
 * about the ones it has this instant computed — which are not on screen yet,
 * and are exactly the ones it needs in order to say where to go.
 */
function questionHasError(errors: FormErrors, questionIndex: number): boolean {
  if (
    errors.questionTitles[questionIndex] ||
    errors.options[questionIndex] ||
    errors.schedules[questionIndex]
  ) {
    return true
  }
  // "1:" cannot match "10:0", since the character after the 1 is a 0 rather
  // than the colon.
  const prefix = `${questionIndex}:`
  return (
    Object.keys(errors.optionNames).some((key) => key.startsWith(prefix)) ||
    Object.keys(errors.optionDescriptions).some((key) => key.startsWith(prefix))
  )
}

/**
 * Everything wrong with the form right now, keyed the way the form is laid
 * out: one message per field, and the option rows by their index.
 *
 * Per-field rather than one message at the bottom, because "Add at least two
 * options" under a form of a dozen inputs makes the reader find the problem
 * themselves; and the reader is looking at the button they just pressed,
 * which is the furthest point on the page from most of the answers. Mantine
 * puts the message under the field it belongs to and turns that field red,
 * which is the whole of the fix.
 */
interface FormErrors {
  title?: string
  description?: string
  emails?: string
  /** Wrong with the poll's list of questions, rather than with any one of them. */
  questions?: string
  /** Wrong with one question's grid, by that question's index: nothing painted, or too many windows. */
  schedules: Record<number, string>
  /** Wrong with one question's title, by that question's index. */
  questionTitles: Record<number, string>
  /** Wrong with one question's option list, by that question's index. */
  options: Record<number, string>
  /** Keyed by optionKey(): one message per field, wherever the field sits. */
  optionNames: Record<string, string>
  optionDescriptions: Record<string, string>
}

function hasErrors(errors: FormErrors): boolean {
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

/** An empty set of messages: what the fields render before the first submit. */
function noErrors(): FormErrors {
  return { schedules: {}, questionTitles: {}, options: {}, optionNames: {}, optionDescriptions: {} }
}

/**
 * Today, in this browser's own zone, as the day a place is resolved against
 * before the poll has any days of its own.
 *
 * Local rather than UTC on purpose: it is standing in for "the poll's first
 * day", which is a wall-clock date the creator picked out of a calendar, and
 * `toISOString` would hand back yesterday's for anybody east of Greenwich in
 * the evening.
 */
function todayInBrowser(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

/**
 * The schedule as it is stored, from the schedule as it was drafted.
 *
 * One tidy, and it is the only thing about a day's shape that is stored at
 * all: **`window` becomes the union of the cells actually painted**. It is the
 * grid's vertical axis (see PollSchedule), and a draft that was painted late
 * into an evening and then rubbed back out would otherwise leave a ballot with
 * empty rows at the bottom of every day.
 *
 * Everything else a schedule used to carry about which days and hours are in
 * bounds is gone, because the options say it: `boundsOf` reads the cells back
 * off them. There is nothing here to prune, because there is nothing stored
 * that could name a day the poll ended up not asking about.
 */
function settle(schedule: PollSchedule, marked: Bounds): PollSchedule {
  return { ...schedule, window: spanOf(marked, schedule) }
}

/**
 * The whole form's rules, in one pass over what has been typed.
 *
 * Computed on every render and shown only once the form has been submitted
 * once: a field that goes red while you are still typing in it is telling
 * you off for being halfway through, and one that stays red after you have
 * fixed it is worse. Submitting is what makes the messages appear; correcting
 * the field is what makes them go, with no second press needed.
 *
 * These are the same rules create_poll enforces, plus the lengths and the
 * duplicate check the suggestion path has always applied to the other way
 * into `candidates` (see src/lib/limits.ts). The database is still the one
 * that decides; nothing here can be trusted, and none of it is relied on.
 * What it buys is being told which box is wrong instead of being told no.
 */
function validate(form: {
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

  // A poll asks at least one question and at most what create_poll_group
  // accepts; the floor is two the moment it is asking more than one, since
  // a group of one is a single-question poll wearing a switch.
  if (form.multiQuestion) {
    if (form.questions.length < 2) {
      errors.questions = 'A multi-question poll needs at least two questions.'
    } else if (form.questions.length > MAX_QUESTIONS) {
      errors.questions = `A poll can ask ${MAX_QUESTIONS} questions; this one asks ${form.questions.length}.`
    }
  }

  form.questions.forEach((question, questionIndex) => {
    // Only read on a poll that asks more than one: a single question is
    // named by the poll's own title, and there is no field on screen here.
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

    // A time question writes no option list, so none of the rules about one
    // apply to it. What it has instead is a painting, and what can be wrong
    // with a painting is the size of the ballot it generates.
    if (question.kind === 'time') {
      const total = countWindows(question.schedule, question.marked)
      const length = describeLength(meetingMinutes(question.schedule))

      // A question collecting its times may be created with none at all, and
      // usually is: the creator says how long the meeting is and where in the
      // world it is, and the group says when. What they mark here is a head
      // start, so an empty calendar is an answer rather than a gap.
      if (form.solicitOptions && total === 0) {
        if (question.days.length > 0) {
          errors.schedules[questionIndex] =
            `Nothing you have marked is ${length} long. Mark a longer stretch, shorten the meeting, or leave the calendar empty and let people add times themselves.`
        }
      } else if (question.days.length === 0) {
        errors.schedules[questionIndex] = 'Mark the times people can meet on the calendar.'
      } else if (total === 0) {
        // Nothing painted is long enough, which is the state a creator reaches
        // by asking for three hours on a two-hour evening -- and which would
        // otherwise be a ballot with nothing on it.
        errors.schedules[questionIndex] =
          `Nothing you have marked is ${length} long, so there are no times to choose between. Mark a longer stretch, or shorten the meeting.`
      } else if (total < 2 && !form.solicitOptions) {
        // The same floor every poll has, arrived at from the other direction:
        // one window is not a choice, it is an announcement. A question that
        // collects its times may start with one, or with none.
        errors.schedules[questionIndex] =
          'That leaves one window to choose from. Mark more of the day, shorten the meeting, or add a day.'
      } else if (total > MAX_OPTIONS) {
        errors.schedules[questionIndex] =
          `That is ${total} windows, and a ballot can hold ${MAX_OPTIONS}. Use a longer meeting, fewer days, or a narrower part of the day.`
      }
      return
    }

    // Compared lowercased: two options that differ only in case are one
    // option to everybody scoring the ballot, and the suggestion path has
    // always refused the pair for that reason. Compared within the question
    // and not across them: two questions are two ballots, and offering the
    // same option on both is ordinary rather than a mistake.
    const seen = new Map<string, number>()
    question.options.forEach((option, index) => {
      const key = optionKey(questionIndex, index)
      const name = option.name.trim()
      if (name.length > OPTION_NAME_MAX) {
        errors.optionNames[key] = tooLong('An option name', name.length, OPTION_NAME_MAX)
      } else if (name) {
        const first = seen.get(name.toLowerCase())
        // Reported against the later row: the first one is the one that keeps
        // the name, so it is not the one that has to change.
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
    // A poll that collects its options may be created with none: the same
    // minimum is applied later, when the creator turns the list into a ballot.
    // Seeding a few here is a head start, not a requirement.
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
      // The tag list refuses a repeat of a tag already in it, so the
      // duplicate that can actually happen is against the checkbox below;
      // and a repeat differing only in case slips past it too.
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

export function CreatePoll() {
  const { session } = useAuth()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const duplicateOf = searchParams.get('from')

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  // Always a list, whether or not the poll asks more than one question; see
  // QuestionDraft. The switch decides what is rendered and what is read, not
  // what is held.
  const [questions, setQuestions] = useState<QuestionDraft[]>([blankQuestion()])
  // The row that has just been added, and the rows on their way out. One
  // arriving at a time, since the cursor can only be in one of them; a set on
  // the way out, because removing three rows in quick succession is a
  // perfectly ordinary thing to do to a list and each of them has to be
  // allowed to finish leaving.
  const [arriving, setArriving] = useState<string | null>(null)
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set())
  const [multiQuestion, setMultiQuestion] = useState(false)
  // Which question's fields are on screen, by key rather than by position;
  // see QuestionDraft.key. Never trusted on its own: what is rendered is
  // `openQuestion` below, which falls back to the first question whenever
  // this points at one that is no longer in the list — which is what happens
  // when a duplicate replaces the whole list, and when the open tab is the
  // one being removed.
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [mode, setMode] = useState<PollMode>('invite')
  const [showVoters, setShowVoters] = useState(false)
  const [showBallots, setShowBallots] = useState(false)
  const [solicitOptions, setSolicitOptions] = useState(false)
  const [emails, setEmails] = useState<string[]>([])
  const [includeSelf, setIncludeSelf] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Whether the form has been submitted once. Until it has, nothing is
  // marked wrong, see validate().
  const [showErrors, setShowErrors] = useState(false)
  // Only ever true on a duplicate; a blank new poll renders immediately.
  const [prefilling, setPrefilling] = useState(Boolean(duplicateOf))

  const myEmail = session?.user.email?.toLowerCase() ?? ''
  const isOpen = mode === 'open'

  const errors = validate({
    title,
    description,
    questions,
    multiQuestion,
    emails,
    includeSelf,
    myEmail,
    isOpen,
    solicitOptions,
  })
  // What the fields actually render. Held back until the first submit, then
  // live: fixing a field clears its message as it is fixed.
  const shown: FormErrors = showErrors ? errors : noErrors()

  // The question the tab strip is actually showing. Derived rather than kept
  // in step by an effect: `openKey` is a wish, and a wish about a question
  // that has been removed — or replaced wholesale, which is what loading a
  // duplicate does — is answered with the first question there is.
  const openQuestion = questions.some((question) => question.key === openKey)
    ? openKey
    : (questions[0]?.key ?? null)

  // What the last section of the form is called. A poll of several questions
  // is a list of questions whatever each of them is asking for; a poll of one
  // is named after the one thing it wants.
  const sectionTitle = multiQuestion ? 'Questions' : 'Decision'

  // Duplicating copies the source poll's settings into the form and stops
  // there; nothing is created until the user submits, so the copy can be
  // edited first. Read through the same RLS and RPCs as everywhere else, so
  // it can only ever duplicate a poll the user can already see.
  useEffect(() => {
    if (!duplicateOf) return
    let cancelled = false

    async function prefill(sourceId: string) {
      // The options come back embedded in the poll rather than alongside it.
      // PostgREST resolves the foreign key from `candidates` to `polls`
      // itself, so one request answers what two used to, and the row-level
      // security on both tables is applied exactly as it is when they are
      // asked separately -- an embedding widens nothing.
      const pollRes = await supabase
        .from('polls')
        .select('*, candidates(*)')
        .eq('id', sourceId)
        .order('sort_order', { referencedTable: 'candidates' })
        .single()
      if (cancelled) return

      if (pollRes.error) {
        setError(`Couldn't load the poll to duplicate: ${pollRes.error.message}`)
        setPrefilling(false)
        return
      }

      const { candidates, ...source } = pollRes.data as Poll & { candidates: PollOption[] }

      setTitle(source.title)
      setDescription(source.description ?? '')
      setMode(source.mode)
      setShowVoters(source.show_voters)
      setShowBallots(source.show_ballots)
      setSolicitOptions(source.solicit_options)

      /**
       * One question of the copy, from the row it is being copied from.
       *
       * A time question copies as a time question. That took saying, because
       * for two migrations it did not: the prefill copied the title, the
       * settings and the option list and knew nothing about `kind`, so
       * "Duplicate" on a time poll produced an *option* poll whose options
       * were sixty ISO timestamps -- a real ballot, drawn as a list, that
       * nobody could read and the calendar could not score.
       *
       * The schedule is the one field on that row this form checks rather
       * than casts, for the reason `pollScheduleSchema` exists: it is the
       * payload the form does arithmetic with, and a `granularity` that
       * arrived as a string would make every window start `NaN` several
       * screens away. One that will not parse leaves a time question with no
       * grid and a line saying so, rather than the list-of-timestamps poll
       * this is all here to prevent.
       */
      const draftFrom = (row: Poll, rows: PollOption[]): QuestionDraft => {
        const blank = blankQuestion()
        const parsed = row.kind === 'time' ? pollScheduleSchema.safeParse(row.schedule) : null
        const grid = parsed?.success ? parsed.data : null

        if (row.kind === 'time') {
          if (!grid) {
            // Still a time question, and still a copy worth making, but with
            // no grid to put under it. Said plainly over calendar fields that
            // are otherwise blank.
            setError(
              "That poll's calendar could not be read, so this copy has its title and settings but none of its times. Mark the days and hours below.",
            )
            return { ...blank, title: row.question_title ?? '', kind: 'time' }
          }

          // The painting comes off the options, exactly as the ballot reads it
          // -- and then forward to the next dates that have not already gone,
          // which is what makes a duplicate of last Friday's poll a poll about
          // a Friday somebody can still attend. See `carryForward`.
          const renewed = carryForward(
            boundsOf(
              rows.map((option) => option.name),
              grid,
            ),
            todayInBrowser(),
          )
          return {
            ...blank,
            title: row.question_title ?? '',
            kind: 'time',
            // The offset copies straight across: it is what the poll was held
            // at and a copy is held at the same one. `offsetPicked` with it,
            // because an offset that came from the poll being copied is an
            // answer rather than this browser's guess, and the dates that have
            // just moved must not move it.
            schedule: grid,
            offsetPicked: true,
            marked: renewed.bounds,
            days: daysOf(renewed.bounds),
            hours: grid.window,
            datesMoved: renewed.weeks,
          }
        }

        // Descriptions come across with their options, so a duplicate of a
        // poll that explained its options does not quietly lose the
        // explanations. The form's two-row minimum is kept if the source
        // somehow had fewer.
        const drafted = rows.map((o) => ({
          ...blankOption(),
          name: o.name,
          description: o.description,
        }))
        return {
          ...blank,
          title: row.question_title ?? '',
          options:
            drafted.length >= 2 ? drafted : [...drafted, blankOption(), blankOption()].slice(0, 2),
        }
      }

      if (source.group_id) {
        // A duplicate of a poll that asks several questions is a poll that
        // asks the same several, not whichever one the creator happened to
        // press Duplicate on. One query for the lot of them: every question of
        // a group carries the whole invite list, so the row-level security on
        // `polls` lets anybody who can see one see its siblings.
        const groupRes = await supabase
          .from('polls')
          .select('*, candidates(*)')
          .eq('group_id', source.group_id)
          .order('question_position')
          .order('sort_order', { referencedTable: 'candidates' })
        if (cancelled) return

        const rows = (groupRes.data as (Poll & { candidates: PollOption[] })[] | null) ?? []
        if (rows.length > 1) {
          setMultiQuestion(true)
          setQuestions(rows.map((row) => draftFrom(row, row.candidates ?? [])))
        } else {
          setQuestions([draftFrom(source as Poll, candidates ?? [])])
        }
      } else {
        setQuestions([draftFrom(source as Poll, candidates ?? [])])
      }

      if (source.mode === 'invite') {
        // Open polls have no invitee list and poll_invitees raises on them.
        const { data: inviteeData } = await supabase.rpc('poll_invitees', {
          p_poll_id: sourceId,
        })
        if (cancelled) return
        const allEmails = ((inviteeData as Invitee[]) ?? []).map((i) => i.email)
        // The creator's own address is driven by the checkbox, not the tag
        // list, so it would otherwise show up twice.
        setIncludeSelf(allEmails.includes(myEmail))
        setEmails(allEmails.filter((e) => e !== myEmail))
      }

      setPrefilling(false)
    }

    prefill(duplicateOf)
    return () => {
      cancelled = true
    }
  }, [duplicateOf, myEmail])

  /** Edits one question's option list in place, leaving the others alone. */
  function patchOptions(question: number, edit: (options: OptionDraft[]) => OptionDraft[]) {
    setQuestions((prev) =>
      prev.map((q, i) => (i === question ? { ...q, options: edit(q.options) } : q)),
    )
  }

  function updateOption(question: number, index: number, patch: Partial<OptionDraft>) {
    patchOptions(question, (options) =>
      options.map((o, i) => (i === index ? { ...o, ...patch } : o)),
    )
  }

  function addOption(question: number) {
    const added = blankOption()
    patchOptions(question, (options) => [...options, added])
    // Which row is new, for its way in and for the cursor. Both want the same
    // answer and neither wants it for long; see `arriving` where it is drawn.
    setArriving(added.key)
  }

  /**
   * Take a row out — which is two things, because the row has to still be
   * there to be seen leaving.
   *
   * It is emptied now and dropped when its animation says so. Emptying is not
   * cosmetic: for the fifth of a second between the press and the row
   * actually going, a row that still held a name would still be an option
   * this form would validate and, if the creator pressed Create inside that
   * window, still be an option the poll was made with. A blank row is already
   * nothing to every rule in this file — blank names are dropped before the
   * poll is created, skipped by the duplicate check, and not counted towards
   * the two a question needs — so emptying it takes it out of the form's
   * reckoning at the moment the reader took it out of theirs, with no rule
   * anywhere needing to hear about `leaving` at all.
   *
   * It keeps its place in the list until it goes, which is what keeps the
   * messages under every row below it pointing at the right row.
   */
  function removeOption(question: number, key: string) {
    setLeaving((prev) => new Set(prev).add(key))
    patchOptions(question, (options) =>
      options.map((o) => (o.key === key ? { ...o, name: '', description: null } : o)),
    )
  }

  /** The row's animation is over, so now it can actually go. */
  function dropOption(question: number, key: string) {
    setLeaving((prev) => {
      const rest = new Set(prev)
      rest.delete(key)
      return rest
    })
    patchOptions(question, (options) => options.filter((o) => o.key !== key))
  }

  function updateQuestionTitle(index: number, value: string) {
    setQuestions((prev) => prev.map((q, i) => (i === index ? { ...q, title: value } : q)))
  }

  /**
   * What pressing a tab means, which is one of two things: open that
   * question, or — for the `+` — make one and open that. One handler because
   * Mantine gives the strip one `onChange`, and the sentinel value is what
   * tells the two apart; see ADD_QUESTION.
   */
  function openOrAddQuestion(value: string | null) {
    if (value === ADD_QUESTION) addQuestion()
    else setOpenKey(value)
  }

  /** Edits one question in place, leaving the others alone. */
  function patchQuestion(index: number, edit: Partial<QuestionDraft>) {
    setQuestions((prev) => prev.map((q, i) => (i === index ? { ...q, ...edit } : q)))
  }

  /**
   * Switching one question between choosing an option and finding a time.
   *
   * Nothing else moves with it any more, and that is the change 0056 bought:
   * a group may hold a calendar among its questions, and a calendar may
   * collect its times from voters. Both were turned off here, and the reasons
   * were real -- `create_poll_group` took no kind, and the suggestion path
   * inserted one option at a time, so a voter "adding Thursday" could leave a
   * day with morning windows and no afternoon. Both are gone: the group reads
   * a kind off each question, and `suggest_options` takes the whole painting
   * in one statement.
   *
   * What the other side of the toggle held is kept rather than cleared, on
   * both sides: the option rows survive a trip through the calendar, and a
   * painting survives a trip through the option rows.
   */
  function switchKind(index: number, next: PollKind) {
    patchQuestion(index, { kind: next })
  }

  /**
   * An offset the creator picked, which from then on is theirs.
   *
   * It is what the poll is held at and everything on the grid is worked out
   * in it. Once it has been chosen by hand the dates no longer move it; see
   * `pickDays`.
   */
  function pickOffset(index: number, next: string) {
    patchQuestion(index, {
      schedule: { ...questions[index].schedule, timezone: next },
      offsetPicked: true,
    })
  }

  /**
   * Days, with the offset caught up to them.
   *
   * **The offset follows only while it is still a guess** -- the form opens on
   * whatever this browser is on today, and today is not when the meeting is:
   * somebody in Denver arranging a July meeting in March is on `-07:00` as
   * they type and `-06:00` when it happens, and a poll left on the opening
   * guess would be an hour out on every option it offers. Once they have
   * picked an offset it is theirs and the dates do not move it.
   *
   * Done in the setter rather than in an effect watching the two, because an
   * effect that writes to the state it watches is a loop waiting for a
   * dependency to be listed slightly wrong.
   */
  function pickDays(index: number, next: string[], marked: Set<GranuleKey>) {
    const question = questions[index]
    const on = [...next].sort()[0]
    const timezone = !question.offsetPicked && on ? viewerOffsetOn(on) : question.schedule.timezone

    patchQuestion(index, {
      days: next,
      marked,
      schedule: { ...question.schedule, timezone },
      // The notice explains where the dates in the picker came from, so it
      // goes as soon as they are the creator's own rather than the copy's.
      datesMoved: 0,
    })
  }

  function addQuestion() {
    const added = blankQuestion()
    setQuestions((prev) => [...prev, added])
    // Adding a question is asking for somewhere to write one, so the strip
    // goes there. Leaving it on the question being left would make the button
    // look like it had done nothing.
    setOpenKey(added.key)
  }

  function removeQuestion(index: number) {
    const left = questions.filter((_, i) => i !== index)
    // Removing the question on screen leaves the strip pointing at nothing,
    // so it moves to the one before it — the neighbour the reader was last
    // looking at — or to the first if this was the first. Decided out here
    // rather than inside the updater below: an updater is asked to be pure
    // and is called twice under StrictMode, which is not where a second
    // piece of state should be set from.
    if (questions[index]?.key === openKey) {
      setOpenKey(left[Math.max(0, index - 1)]?.key ?? null)
    }
    setQuestions(left)
  }

  /**
   * Turning the poll into several questions, or back into one.
   *
   * On: the options already typed become question 1, and a second empty
   * question is added, because the switch is a promise that there is somewhere
   * to put the next question and an empty list is not that.
   *
   * Off: question 1 is kept whole and the rest are dropped. Nothing is merged
   * -- two ballots' worth of options concatenated into one is not what anybody
   * meant -- and what is dropped is on screen at the moment the switch is
   * pressed, so it is a visible loss rather than a silent one.
   *
   */
  function toggleMultiQuestion(on: boolean) {
    setMultiQuestion(on)
    if (on) {
      setQuestions((prev) => (prev.length >= 2 ? prev : [...prev, blankQuestion()]))
    } else {
      setQuestions((prev) => prev.slice(0, 1))
    }
  }

  // null is "no description", and is also what collapses the field: showing a
  // description means giving it an empty string to type into, and hiding one
  // throws whatever was in it away. Keeping hidden text would mean a poll
  // could carry a description its creator can no longer see, which is the one
  // way this field could surprise anybody.
  function toggleDescription(question: number, index: number) {
    patchOptions(question, (options) =>
      options.map((o, i) =>
        i === index ? { ...o, description: o.description === null ? '' : null } : o,
      ),
    )
  }

  async function handleSubmit() {
    setError(null)
    setShowErrors(true)
    // Every rule is checked in one pass and every failure is shown at once:
    // fixing one problem only to be told about the next is how a form of
    // this size turns into four round trips.
    if (hasErrors(errors)) {
      // And on a poll of several questions, the tab strip goes to the first
      // question with something wrong in it. Every question is checked
      // whether or not it is on screen, so without this a creator could press
      // Create, watch nothing happen, and have no way of knowing the problem
      // was two tabs away. The mark on the tabs says which ones; this puts
      // them in front of the one to fix first.
      if (multiQuestion) {
        const firstBad = questions.findIndex((_, index) => questionHasError(errors, index))
        if (firstBad >= 0) setOpenKey(questions[firstBad].key)
      }
      return
    }

    // A time question's ballot is generated here, in the browser, and sent
    // through the same create_poll as any other list of options. That is the
    // whole trick: from this line on there is nothing about this poll the
    // database handles differently, apart from two columns it stores and
    // hands back.
    //
    // The schedule is tidied on the way out rather than kept tidy on the way
    // in, because what the form holds is a draft and what is stored is a
    // record: `window` becomes exactly the union of the cells the creator
    // ended up leaving painted, which is the axis the ballot is drawn on.
    //
    // Blank rows are dropped here and in the database alike, and the
    // descriptions travel with their option rather than beside it, so a
    // dropped row cannot slide every later description onto the wrong one.
    const cleaned = questions.map((question) => {
      if (question.kind !== 'time') {
        return {
          title: question.title.trim(),
          kind: 'option' as const,
          schedule: null,
          options: question.options
            .map((o) => ({ name: o.name.trim(), description: o.description?.trim() || null }))
            .filter((o) => o.name),
        }
      }
      const grid = settle(question.schedule, question.marked)
      return {
        title: question.title.trim(),
        kind: 'time' as const,
        schedule: grid,
        options: enumerateWindows(grid, question.marked).map((name) => ({
          name,
          description: null,
        })),
      }
    })

    const typedEmails = emails.map((e) => e.trim().toLowerCase()).filter(Boolean)
    const allEmails = Array.from(new Set(includeSelf ? [...typedEmails, myEmail] : typedEmails))
    const only = cleaned[0]

    setSubmitting(true)
    // One transaction either way: the poll, its questions, their options and
    // its invitees land together or not at all. That is the whole reason a
    // group is created by one function rather than by a loop out here -- a
    // failure part-way would leave a real, half-built poll behind, with the
    // invitations for it already sent.
    const { data, error: rpcError } = multiQuestion
      ? await supabase.rpc('create_poll_group', {
          p_title: title.trim(),
          // Sent even when empty, unlike the option descriptions below: this
          // parameter has no DEFAULT in the database, so omitting it would
          // leave PostgREST with no overload to call. '' and null reach the
          // same place — both functions run it through
          // `nullif(trim(coalesce(p_description, '')), '')`.
          p_description: description.trim(),
          // Each question says which kind it is and carries its own grid; see
          // 0056_schedule_options.sql. A question that is not a calendar sends
          // `schedule: null`, which is what the check on that side refuses to
          // see anything else in.
          p_questions: cleaned,
          p_emails: isOpen ? [] : allEmails,
          p_mode: mode,
          p_show_voters: showVoters,
          p_show_ballots: showBallots,
          p_solicit_options: solicitOptions,
        })
      : await supabase.rpc('create_poll', {
          p_title: title.trim(),
          p_description: description.trim(),
          p_options: only.options.map((o) => o.name),
          p_emails: isOpen ? [] : allEmails,
          p_mode: mode,
          p_show_voters: showVoters,
          p_show_ballots: showBallots,
          p_solicit_options: solicitOptions,
          p_kind: only.kind,
          // The database ties these two together: a schedule on an option
          // poll is refused, and a time poll without one cannot be stored.
          p_schedule: only.schedule ?? undefined,
          // Most polls describe nothing, and send nothing rather than a row of
          // blanks the database would only throw away again. Where they are
          // sent, an option with no description travels as '' rather than
          // null: `insert_poll_row` runs the whole column through
          // `nullif(trim(coalesce(…, '')), '')`, so the two arrive as the same
          // absent description, and a `text[]` cannot say "nullable elements"
          // to the generated types.
          p_option_descriptions: only.options.some((o) => o.description)
            ? only.options.map((o) => o.description ?? '')
            : undefined,
        })
    setSubmitting(false)

    if (rpcError) {
      setError(rpcError.message)
      return
    }

    notifications.show({ message: 'Poll created', color: 'green' })
    navigate(`/polls/${data as string}`)
  }

  /**
   * One question's fields: what it asks, and the options it offers.
   *
   * Pulled out of the render because there are now two frames it can sit in —
   * a tab panel on a poll that asks several, and the bare form on a poll that
   * asks one — and the fields themselves must not differ between them. What a
   * frame decides is which questions are on screen, never what a question
   * looks like.
   */
  function questionFields(question: QuestionDraft, questionIndex: number) {
    return (
      <Stack gap="xs">
        {/* A question of a multi-question poll is titled; the single question
            of an ordinary poll is not, because the poll's own title names it.
            Full width, with nothing beside it: what used to sit here was the
            button that removes the question, and see where it went. */}
        {multiQuestion && (
          <TextInput
            label="Title"
            placeholder="What is this question asking?"
            value={question.title}
            onChange={(e) => updateQuestionTitle(questionIndex, e.currentTarget.value)}
            error={shown.questionTitles[questionIndex]}
            required
          />
        )}

        {/* What this question is choosing between, at the head of the fields
            whose whole shape it decides. It sits here rather than up in
            Configuration because it is not a setting on a ballot -- it is
            which ballot this question is, and the fields below it are the
            answer. Per question since 0056, which is what lets a poll ask
            "what are we watching?" and "when?" in one sitting. */}
        <SegmentedControl
          fullWidth
          value={question.kind}
          onChange={(v) => switchKind(questionIndex, v as PollKind)}
          data={[
            { value: 'option', label: 'Choose an option' },
            { value: 'time', label: 'Find a time' },
          ]}
        />

        {question.kind === 'time' ? (
          <>
            {/* Dates that moved on their own are exactly the kind of thing a
                creator notices two screens later, or never -- so a copy whose
                dates had already gone says where the ones in the picker came
                from. It goes as soon as they mark a day of their own; see
                pickDays. */}
            {question.datesMoved > 0 && (
              <Alert color="blue" title="These dates have moved">
                The poll you copied is in the past, so this one asks about the same days of the week{' '}
                {question.datesMoved === 1 ? 'a week' : `${question.datesMoved} weeks`} later. Mark
                different days on the calendar below if that is not where you want it.
              </Alert>
            )}
            {solicitOptions && (
              <Text size="xs" c="dimmed">
                Voters will be able to add times of their own later; what you mark here is the head
                start.
              </Text>
            )}
            {/* No option rows at all: the ballot is generated from these
                answers and the calendar under them, which is the whole of what
                makes a time question a question about times. See
                enumerateWindows, and handleSubmit, where the windows become
                the ordinary p_options every other poll sends. */}
            <ScheduleFields
              schedule={question.schedule}
              days={question.days}
              hours={question.hours}
              marked={question.marked}
              onScheduleChange={(next) => patchQuestion(questionIndex, { schedule: next })}
              onDaysChange={(next, marked) => pickDays(questionIndex, next, marked)}
              onHoursChange={(next) => patchQuestion(questionIndex, { hours: next })}
              onMarkedChange={(next) => patchQuestion(questionIndex, { marked: next })}
              onOffsetChange={(next) => pickOffset(questionIndex, next)}
              error={shown.schedules[questionIndex]}
            />
          </>
        ) : (
          <>
            <Text size="xs" c="dimmed">
              {solicitOptions
                ? 'Voters will be able to add to this list later.'
                : 'Use + to add a description to an option.'}
            </Text>

            {question.options.map((option, index) => (
              /* The row's own box, which is what opens and closes; see
             listRow.module.css. The handler is hung only on a row that is
             leaving, so the arrival's animation cannot be mistaken for the
             departure's ending. */
              <div
                key={option.key}
                className={`${listRow.row} ${option.key === arriving ? listRow.joining : ''} ${
                  leaving.has(option.key) ? listRow.leaving : ''
                }`}
                onAnimationEnd={
                  leaving.has(option.key) ? () => dropOption(questionIndex, option.key) : undefined
                }
              >
                <Group className={listRow.content} gap="xs" align="flex-start" wrap="nowrap">
                  <Stack gap={4} style={{ flex: 1 }}>
                    <TextInput
                      value={option.name}
                      onChange={(e) =>
                        updateOption(questionIndex, index, { name: e.currentTarget.value })
                      }
                      placeholder={`Option ${index + 1}`}
                      error={shown.optionNames[optionKey(questionIndex, index)]}
                      /* The cursor follows the row that was just asked for. Adding
                   an option and then having to reach for the box it made is
                   the same press twice. */
                      autoFocus={option.key === arriving}
                    />
                    {option.description !== null && (
                      <DescriptionField
                        value={option.description}
                        onChange={(e) =>
                          updateOption(questionIndex, index, { description: e.currentTarget.value })
                        }
                        placeholder={`Option ${index + 1} description`}
                        error={shown.optionDescriptions[optionKey(questionIndex, index)]}
                        autoFocus
                      />
                    )}
                  </Stack>
                  <Tooltip
                    label={option.description === null ? 'Add description' : 'Remove description'}
                    withArrow
                  >
                    <ActionIcon
                      variant="subtle"
                      color="gray"
                      onClick={() => toggleDescription(questionIndex, index)}
                      aria-label={
                        option.description === null
                          ? `Add a description to option ${index + 1}`
                          : `Remove the description from option ${index + 1}`
                      }
                    >
                      {option.description === null ? '+' : '−'}
                    </ActionIcon>
                  </Tooltip>
                  <ActionIcon
                    variant="subtle"
                    color="red"
                    onClick={() => removeOption(questionIndex, option.key)}
                    /* Two rows is the floor for a poll that ships its options with
             it, and no floor at all for one that collects them. */
                    disabled={!solicitOptions && question.options.length <= 2}
                    aria-label="Remove option"
                  >
                    &times;
                  </ActionIcon>
                </Group>
              </div>
            ))}

            {/* Wrong with the list rather than with a row in it, so it sits
                under the list rather than under any one field. */}
            {shown.options[questionIndex] && (
              <Text c="var(--mantine-color-error)" size="sm">
                {shown.options[questionIndex]}
              </Text>
            )}
          </>
        )}

        {/* Removing the question sits opposite adding an option, at the end
            of the question it acts on, and says in words what it removes.
            It was a bare red × beside the title field before, which put a
            control that discards a whole question — its title, its options,
            its descriptions — inside the row for editing that question's
            title, where the nearest reading of it was "clear this field".
            Two buttons that destroy different amounts should not look alike
            and should not sit together, so this one is named and the option
            row's × keeps the row it belongs to.

            Adding a question stays in the tab strip, where the tabs it adds
            to are; removing one cannot live there without either nesting a
            button inside a tab or making a tab that is not a question. What
            the two share is not a row — it is that each is next to what it
            acts on. */}
        <Group gap="sm" align="center" justify="space-between">
          {question.kind === 'time' ? (
            <span />
          ) : (
            <Button
              variant="light"
              size="xs"
              onClick={() => addOption(questionIndex)}
              w="fit-content"
              disabled={question.options.length >= MAX_OPTIONS}
            >
              Add option
            </Button>
          )}
          {multiQuestion && (
            <Button
              variant="light"
              size="xs"
              color="orange"
              onClick={() => removeQuestion(questionIndex)}
              w="fit-content"
              /* Two questions is the floor: below it the poll asks one
                 question, which is what the switch above is for rather than
                 something to arrive at by removing the second. */
              disabled={questions.length <= 2}
              title={
                questions.length <= 2
                  ? 'A poll of several questions asks at least two; turn off Multiple questions instead.'
                  : undefined
              }
            >
              Remove question
            </Button>
          )}
        </Group>
      </Stack>
    )
  }

  // Only ever on a duplicate, and only until the source poll comes back:
  // the form it is standing in for is the one being filled in from it.
  if (prefilling) return <FormSkeleton />

  return (
    <Stack maw={720} mx="auto" gap="md">
      <Title order={2} ta="center">
        {duplicateOf ? 'Duplicate poll' : 'New poll'}
      </Title>

      <Stack gap={2}>
        <Title order={4} id="poll-title-label">
          Title
          <span aria-hidden="true" style={{ color: 'var(--mantine-color-red-6)' }}>
            {' *'}
          </span>
        </Title>
        <TextInput
          placeholder="A title for your poll"
          value={title}
          onChange={(e) => setTitle(e.currentTarget.value)}
          aria-labelledby="poll-title-label"
          error={shown.title}
          required
        />
      </Stack>

      <Stack gap={2}>
        <Title order={4} id="poll-title-description">
          Description
        </Title>
        <Textarea
          placeholder="Optional additional details"
          value={description}
          onChange={(e) => setDescription(e.currentTarget.value)}
          aria-labelledby="poll-title-description"
          error={shown.description}
          autosize
          minRows={2}
        />
      </Stack>

      <Stack gap={2}>
        <Title order={4}>Voters</Title>
        <Card withBorder p="sm">
          <Stack gap="xs">
            <SegmentedControl
              value={mode}
              onChange={(v) => setMode(v as PollMode)}
              data={[
                { value: 'invite', label: 'Invited people' },
                { value: 'open', label: 'Anyone with the link' },
              ]}
            />
            {isOpen ? (
              <Alert color="yellow" title="Unauthenticated">
                <Stack gap={4}>
                  <Text size="sm">People can vote more than once by using multiple browsers.</Text>
                </Stack>
              </Alert>
            ) : (
              <>
                <TagsInput
                  description={
                    <>
                      <span className={styles.emailDescriptionShort}>
                        Type an email and press Enter to add it.
                      </span>
                      <span className={styles.emailDescriptionLong}>
                        Type an email and press Enter to add it or paste a comma separated list of
                        emails.
                      </span>
                    </>
                  }
                  placeholder="them@example.com"
                  value={emails}
                  onChange={setEmails}
                  error={shown.emails}
                />
                <Checkbox
                  label={`Include me as a voter (${myEmail})`}
                  checked={includeSelf}
                  onChange={(e) => setIncludeSelf(e.currentTarget.checked)}
                />
              </>
            )}
          </Stack>
        </Card>
      </Stack>

      <Stack gap={2}>
        <Title order={4}>Configuration</Title>
        <Card withBorder p="sm">
          <Stack gap="sm">
            <Switch
              checked={showVoters}
              onChange={(e) => setShowVoters(e.currentTarget.checked)}
              label={mode === 'invite' ? 'Show voter emails' : 'Show voter names'}
            />

            <Switch
              checked={showBallots}
              onChange={(e) => setShowBallots(e.currentTarget.checked)}
              label="Publish ballots"
            />

            {/* Both of these used to be hidden on a time poll, because
                neither worked on a calendar: `create_poll_group` took no kind,
                and a voter "adding Thursday" adds a dozen options one request
                at a time. 0056 settles both, so a poll may ask a calendar
                among its questions and a calendar may collect its times. */}
            <Switch
              checked={solicitOptions}
              onChange={(e) => setSolicitOptions(e.currentTarget.checked)}
              label="Solicit options from voters"
            />

            <Switch
              checked={multiQuestion}
              onChange={(e) => toggleMultiQuestion(e.currentTarget.checked)}
              label="Multiple questions"
            />
          </Stack>
        </Card>
      </Stack>

      <Stack gap={2}>
        <Title order={4}>{sectionTitle}</Title>
        <Card withBorder p="sm">
          {/* Last, because it is the only part of the form whose shape depends on
          the answers above it: a poll collecting its options can be created
          with none at all, and the rows here become a head start rather than
          the ballot. */}
          <Stack gap="sm">
            {multiQuestion ? (
              /* One question at a time, behind a strip of tabs. Every question
             laid out at once was a form that grew with the poll: five
             questions of five options each is fifty fields in one scroll,
             with no way to see the shape of what is being asked, and no way
             back from question four to question one except past everything in
             between. The tabs are also the shape the poll wears once it
             exists — QuestionStrip, on the voting side — so a creator lays
             the poll out the way their voters will walk through it.

             Nothing about what is submitted changes: the questions are one
             list in order, and all of them are validated on every submit
             whether or not they are on screen. A tab whose question has
             something wrong with it says so, because validating a question
             nobody can see is only worth doing if the reader is told where to
             look. */
              <Tabs value={openQuestion} onChange={openOrAddQuestion} keepMounted={false}>
                <Tabs.List>
                  {questions.map((question, questionIndex) => (
                    <Tabs.Tab
                      key={question.key}
                      value={question.key}
                      rightSection={
                        questionHasError(shown, questionIndex) ? (
                          <Text component="span" c="var(--mantine-color-error)" fw={700} size="sm">
                            !
                          </Text>
                        ) : undefined
                      }
                    >
                      <Text component="span" size="sm" truncate maw={160}>
                        {`Question ${questionIndex + 1}`}
                      </Text>
                    </Tabs.Tab>
                  ))}
                  {/* Last in the row, where a new tab lands. It is never the open
                  tab — `openQuestion` is only ever a question's key — so
                  pressing it makes a question and opens that instead, and a
                  selected `+` is a state the strip cannot be in. */}
                  <Tabs.Tab
                    value={ADD_QUESTION}
                    disabled={questions.length >= MAX_QUESTIONS}
                    aria-label="Add a question"
                    title={
                      questions.length >= MAX_QUESTIONS
                        ? `A poll can ask ${MAX_QUESTIONS} questions.`
                        : 'Add a question to this poll'
                    }
                  >
                    +
                  </Tabs.Tab>
                </Tabs.List>

                {/* Wrong with the poll's list of questions rather than with any
                one of them, so it sits under the strip rather than in a
                panel. */}
                {shown.questions && (
                  <Text c="var(--mantine-color-error)" size="sm" mt="xs">
                    {shown.questions}
                  </Text>
                )}

                {questions.map((question, questionIndex) => (
                  <Tabs.Panel key={question.key} value={question.key} pt="xs">
                    {questionFields(question, questionIndex)}
                  </Tabs.Panel>
                ))}
              </Tabs>
            ) : (
              /* One question and no strip at all: the poll's own title names it,
             and a single tab is a frame around nothing. */
              questionFields(questions[0], 0)
            )}
          </Stack>
        </Card>
      </Stack>

      {error && (
        <Text c="red" size="sm">
          {error}
        </Text>
      )}

      <Group justify="flex-end">
        <Button onClick={handleSubmit} loading={submitting}>
          {duplicateOf ? 'Create copy' : 'Create poll'}
        </Button>
      </Group>
    </Stack>
  )
}
