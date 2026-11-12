import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { CopyIcon, InfoIcon, PlusIcon, TrashIcon } from '@phosphor-icons/react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import {
  ActionIcon,
  Alert,
  Anchor,
  Button,
  Card,
  Checkbox,
  Group,
  NumberInput,
  Popover,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Tabs,
  TagsInput,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { useAuth } from '../lib/auth'
import { supabase } from '../lib/supabase'
import { DescriptionField, DescriptionToggle } from '../components/DescriptionField'
import { ScheduleFields } from '../components/ScheduleFields'
import {
  boundsOf,
  carryForward,
  countWindows,
  daysOf,
  gridFor,
  granularityFor,
  isDaily,
  meetingMinutes,
  overlaps,
  regrid,
  snapHours,
  toMinutes,
  enumerateWindows,
  fromDay,
  granuleKey,
  startingOn,
  todayIn,
  type GranuleKey,
  type ScheduleDay,
} from '../lib/schedule'
import { DuplicateDates } from '../components/DuplicateDates'
import { viewerOffsetOn } from '../lib/timezones'
import {
  ballotSheetSchema,
  parseAnswer,
  pollResultsSchema,
  pollScheduleSchema,
} from '../lib/rpcSchemas'
import { carriedFrom } from '../lib/sequel'
import { CarriedVoters } from '../components/CarriedVoters'
import {
  blankCarried,
  blankOption,
  blankQuestion,
  carriedOf,
  gridOf,
  isTimeQuestion,
  overlapOf,
  reconcileGrid,
  numberOf,
  kindValueOf,
  hasErrors,
  noErrors,
  optionKey,
  questionHasError,
  settle,
  validate,
  type FormErrors,
  type OptionDraft,
  type QuestionDraft,
} from '../lib/pollForm'
import { FormSkeleton } from '../components/Skeletons'
import type { PollHeadingProps } from '../components/PollHeading'
import { launchTitleFlight } from '../lib/headingFlight'
import { readPollDefaults, savePollDefaults } from '../lib/pollDefaults'
import styles from './CreatePoll.module.css'
import listRow from '../components/listRow.module.css'
import { AMOUNT_MAX, MAX_OPTIONS, MAX_QUESTIONS } from '../lib/limits'
import { pollIdFromParam, pollPath } from '../lib/pollId'
import type { Invitee, Poll, PollKind, PollMode, PollOption } from '../lib/types'
import {
  canBeCalendar,
  CHOICE_NUMBER,
  CHOICE_ORDER,
  choiceLabel,
  choiceNumberLabel,
  optionNumberOf,
  picksSeveral,
  SEQUENTIAL_KINDS,
} from '../lib/choices'
import { usePageTitle } from '../lib/pageTitle'
import { announce } from '../lib/announce'

/** Why the voter switch is on and fixed while a question is an option assignment. */
const ASSIGNMENT_SHOWS_VOTERS = 'An option assignment says who gets which option.'

/** The *Choice* entry that makes a question sequential; its type is a second select. */
const SEQUENTIAL = 'sequential'

/** The `+` tab's value. Question keys are `question-N`, so it cannot collide. */
const ADD_QUESTION = 'add-question'

/** An option's name field, for moving the cursor to it. */
const optionNameId = (key: string) => `option-name-${key}`

export function CreatePoll() {
  usePageTitle('New poll')
  const { session, anonymous } = useAuth()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  // A duplicate, or a sequel: the same copy, with a sequel's STAR questions
  // made sequential and their earlier voters filled in (lib/sequel.ts).
  const sequelParam = searchParams.get('sequel')
  const fromParam = searchParams.get('from') ?? sequelParam
  const duplicateOf = fromParam && pollIdFromParam(fromParam)
  const sequel = Boolean(sequelParam)

  // The last poll's settings; a duplicate is filled from its source instead.
  const [defaults] = useState(readPollDefaults)
  const [title, setTitle] = useState('')
  // Where a new poll's title flies from.
  const titleField = useRef<HTMLInputElement>(null)
  const [description, setDescription] = useState('')
  const [questions, setQuestions] = useState<QuestionDraft[]>(() =>
    defaults.multiQuestion ? [blankQuestion(), blankQuestion()] : [blankQuestion()],
  )
  // The option row just added (for its entrance and the cursor), and rows
  // animating out.
  const [arriving, setArriving] = useState<string | null>(null)
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set())
  const [multiQuestion, setMultiQuestion] = useState(defaults.multiQuestion)
  // The wished-for tab; see `openQuestion` for what is actually shown.
  const [openKey, setOpenKey] = useState<string | null>(null)
  // Without an account a poll can only be open (an invite poll sends email).
  const [mode, setMode] = useState<PollMode>(anonymous ? 'open' : defaults.mode)
  const [showVoters, setShowVoters] = useState(defaults.showVoters)
  const [showBallots, setShowBallots] = useState(defaults.showBallots)
  const [solicitOptions, setSolicitOptions] = useState(defaults.solicitOptions)
  const [emails, setEmails] = useState<string[]>([])
  const [includeSelf, setIncludeSelf] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Errors are shown from the first submit on.
  const [showErrors, setShowErrors] = useState(false)
  const [prefilling, setPrefilling] = useState(Boolean(duplicateOf))
  // A duplicated time poll asks for its new first day before the form; see DuplicateDates.
  const [datePick, setDatePick] = useState<{
    /** The copied poll's first day, across its time questions. */
    from: ScheduleDay
    /** Where the picker starts: that day carried forward by whole weeks. */
    suggested: ScheduleDay
    today: ScheduleDay
    /** Each time question's painting as copied, by question key. */
    copied: Map<string, Set<GranuleKey>>
  } | null>(null)

  const myEmail = session?.user.email?.toLowerCase() ?? ''
  const isOpen = mode === 'open'
  // A sequential question shows who voted and the ballots, or neither: a
  // ballot's weight on an anonymous sheet would say whose it is. So while any
  // question is sequential the two settings are one switch.
  const anySequential = questions.some((question) => question.sequential)
  // An option assignment says who gets which option, so while any question
  // is one, voters are shown whatever the switch was left at.
  const anyAssignment = questions.some((q) => !q.sequential && q.kind === 'assignment')
  const votersShown = showVoters || anyAssignment
  const publishBallots = anySequential ? votersShown : showBallots

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
  const shown: FormErrors = showErrors ? errors : noErrors()

  // Falls back to the first question when `openKey` names one that is gone.
  const openQuestion = questions.some((question) => question.key === openKey)
    ? openKey
    : (questions[0]?.key ?? null)

  const sectionTitle = multiQuestion ? 'Questions' : 'Decision'

  /**
   * A sequel's earlier voters for one question of the poll it follows: null
   * for a question that cannot be sequential (it copies as an ordinary one),
   * a sentence where its ballots could not be read. Read through the same
   * gates the results page reads through, so only a poll whose ballots are
   * published with names on them gives anything.
   */
  async function sequelOf(
    row: Poll,
    invitees: string[] | null,
  ): Promise<{ voter: string; given: number }[] | string | null> {
    if (!SEQUENTIAL_KINDS.includes(row.kind)) return null
    const [sheetRes, resultsRes, skippedRes] = await Promise.all([
      supabase.rpc('poll_ballots', { p_poll_id: row.id }),
      supabase.rpc('get_poll_results', { p_poll_id: row.id }),
      supabase.rpc('get_poll_carried_weights', { p_poll_id: row.id }),
    ])
    const failure = sheetRes.error ?? resultsRes.error ?? skippedRes.error
    if (failure) {
      return `Couldn't fill in the earlier voters from that poll: ${failure.message}`
    }
    const sheet = parseAnswer(ballotSheetSchema, 'poll_ballots', sheetRes.data)
    const results = parseAnswer(pollResultsSchema, 'get_poll_results', resultsRes.data)
    const skipped = Array.isArray(skippedRes.data)
      ? (skippedRes.data as { voter: string; given: number }[])
      : []
    if (sheet.error !== null || results.error !== null) {
      return `Couldn't fill in the earlier voters from that poll: ${sheet.error ?? results.error}`
    }
    const rows = carriedFrom(sheet.value, results.value, skipped)
    // An invite poll's earlier voters must be on its list; one taken off it
    // since has nothing to vote with.
    return invitees ? rows.filter((r) => invitees.includes(r.voter.toLowerCase())) : rows
  }

  // Duplicating fills the form from the source poll; nothing is created until
  // submit. Read through ordinary RLS, so only a poll the user can see.
  useEffect(() => {
    if (!duplicateOf) return
    let cancelled = false

    async function prefill(sourceId: string) {
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
       * One question of the copy. A time question copies as a time question;
       * its schedule is validated rather than cast, since bad numbers would
       * break the window arithmetic far from here.
       */
      // Each time question's painting as copied, for the date step.
      const copiedTimes = new Map<string, Set<GranuleKey>>()
      const clock: { today?: ScheduleDay } = {}

      const draftFrom = (row: Poll, rows: PollOption[]): QuestionDraft => {
        const fresh = blankQuestion()
        // The source's kind and number come across; a number it did not set
        // leaves the form's default for that kind. A budget's number is its
        // budget, which has a box of its own.
        const number = row.kind_value ?? null
        const blank: QuestionDraft = {
          ...fresh,
          kind: row.kind,
          kindNumbers:
            number === null || row.kind === 'budget'
              ? fresh.kindNumbers
              : { ...fresh.kindNumbers, [row.kind]: number },
          budget: row.kind === 'budget' && number !== null ? number : '',
        }
        const timed = row.schedule != null
        const parsed = timed ? pollScheduleSchema.safeParse(row.schedule) : null
        const grid = parsed?.success ? parsed.data : null

        if (timed) {
          if (!grid) {
            setError(
              "That poll's calendar could not be read, so this copy has its title and settings but none of its times. Mark the days and hours below.",
            )
            return { ...blank, calendar: true, title: row.question_title ?? '' }
          }

          // The copy's length, overlap and offset are the source's, and its
          // grid is the one the form draws for them, which an older poll
          // (stepped on half-hour cells) may not have been drawn on.
          const length = meetingMinutes(grid)
          const base = {
            timezone: grid.timezone,
            window: grid.window,
            granularity: granularityFor(length),
            desired_slots: length / granularityFor(length),
          }
          const overlap = overlaps(grid)
          const drawn = gridFor(base, length, overlap)
          const hours = isDaily(drawn) ? grid.window : snapHours(grid.window, drawn.granularity)

          // Read the painting off the options, onto that grid, then move it
          // forward whole weeks past today (on the poll's clock).
          const read = boundsOf(
            rows.map((option) => option.name),
            grid,
          )
          const copied =
            isDaily(drawn) || drawn.granularity === grid.granularity
              ? read
              : regrid(read, grid.granularity, drawn.granularity, toMinutes(hours.start))
          const renewed = carryForward(copied, todayIn(grid.timezone))
          if (copied.size > 0) {
            copiedTimes.set(blank.key, copied)
            clock.today ??= todayIn(grid.timezone)
          }
          return {
            ...blank,
            title: row.question_title ?? '',
            calendar: true,
            // The source's offset and overlap are choices, so later changes
            // to the dates or the kind must not move them.
            schedule: base,
            overlap,
            // An assignment's places per time copy as the box it was given in.
            placesPerTime: grid.places ?? '',
            offsetPicked: true,
            marked: renewed.bounds,
            days: daysOf(renewed.bounds),
            hours,
            datesMoved: renewed.weeks,
          }
        }

        // A table read, so an option's cost or places are its column, `kind_value`.
        const drafted = rows.map((o) => ({
          ...blankOption(),
          name: o.name,
          description: o.description,
          number: (o as PollOption & { kind_value?: number | null }).kind_value ?? '',
        }))
        return {
          ...blank,
          title: row.question_title ?? '',
          options:
            drafted.length >= 2 ? drafted : [...drafted, blankOption(), blankOption()].slice(0, 2),
        }
      }

      // The questions copied, in order, for a sequel's ballots.
      let sourceRows: Poll[] = []
      if (source.group_id) {
        // Copy every question of the group. Each question carries the whole
        // invite list, so RLS lets the reader see all siblings.
        const groupRes = await supabase
          .from('polls')
          .select('*, candidates(*)')
          .eq('group_id', source.group_id)
          .order('question_position')
          .order('sort_order', { referencedTable: 'candidates' })
        if (cancelled) return

        const rows = (groupRes.data as (Poll & { candidates: PollOption[] })[] | null) ?? []
        sourceRows = rows.length > 1 ? rows : [source as Poll]
        if (rows.length > 1) {
          setMultiQuestion(true)
          setQuestions(rows.map((row) => draftFrom(row, row.candidates ?? [])))
        } else {
          setMultiQuestion(false)
          setQuestions([draftFrom(source as Poll, candidates ?? [])])
        }
      } else {
        setMultiQuestion(false)
        setQuestions([draftFrom(source as Poll, candidates ?? [])])
      }

      let invitees: string[] | null = null
      if (source.mode === 'invite') {
        // `poll_invitees` raises on open polls.
        const { data: inviteeData } = await supabase.rpc('poll_invitees', {
          p_poll_id: sourceId,
        })
        if (cancelled) return
        const allEmails = ((inviteeData as Invitee[]) ?? []).map((i) => i.email)
        invitees = allEmails
        // The creator's own address is the checkbox, not a tag.
        setIncludeSelf(allEmails.includes(myEmail))
        setEmails(allEmails.filter((e) => e !== myEmail))
      }

      if (sequel) {
        const sources = source.group_id ? sourceRows : [source as Poll]
        const carried = await Promise.all(sources.map((row) => sequelOf(row, invitees)))
        if (cancelled) return
        const failed = carried.find((c) => typeof c === 'string')
        if (failed) setError(failed)
        setQuestions((prev) =>
          prev.map((question, i) => {
            const rows = carried[i]
            if (!Array.isArray(rows)) return question
            return {
              ...question,
              sequential: true,
              carried: rows.length
                ? rows.map((row) => blankCarried(row.voter, row.given))
                : [blankCarried()],
            }
          }),
        )
      }

      // A copy of a time poll is nearly always about other dates, so ask for
      // them first. Several time questions move together, from the earliest.
      const today = clock.today
      if (copiedTimes.size > 0 && today) {
        const from = [...copiedTimes.values()].map((bounds) => daysOf(bounds)[0]).sort()[0]
        const suggested = daysOf(carryForward(new Set([granuleKey(from, 0)]), today).bounds)[0]
        setDatePick({ from, suggested, today, copied: copiedTimes })
      }

      setPrefilling(false)
    }

    prefill(duplicateOf)
    return () => {
      cancelled = true
    }
  }, [duplicateOf, myEmail, sequel])

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
    setArriving(added.key)
  }

  /**
   * Start a row's exit. It is emptied immediately -- a blank row counts for
   * nothing in validation or submit -- and dropped when its animation ends.
   */
  function removeOption(question: number, key: string) {
    setLeaving((prev) => new Set(prev).add(key))
    patchOptions(question, (options) =>
      options.map((o) => (o.key === key ? { ...o, name: '', description: null } : o)),
    )
  }

  function dropOption(question: number, key: string) {
    setLeaving((prev) => {
      const rest = new Set(prev)
      rest.delete(key)
      return rest
    })
    patchOptions(question, (options) => options.filter((o) => o.key !== key))
  }

  /**
   * Enter in an option's name or description goes to the next option's name,
   * making one at the end of the list, so a list can be typed without the
   * mouse. Shift+Enter still breaks a line in a description.
   */
  function onOptionEnter(e: KeyboardEvent<HTMLElement>, question: number, index: number) {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
    e.preventDefault()
    const options = questions[question].options
    const next = options.slice(index + 1).find((o) => !leaving.has(o.key))
    if (next) document.getElementById(optionNameId(next.key))?.focus()
    else if (options.length < MAX_OPTIONS) addOption(question)
  }

  function updateQuestionTitle(index: number, value: string) {
    setQuestions((prev) => prev.map((q, i) => (i === index ? { ...q, title: value } : q)))
  }

  function openOrAddQuestion(value: string | null) {
    if (value === ADD_QUESTION) addQuestion()
    else setOpenKey(value)
  }

  /** Every edit goes through `reconcileGrid`, which carries the painting onto any new grid. */
  function patchQuestion(index: number, edit: Partial<QuestionDraft>) {
    setQuestions((prev) =>
      prev.map((q, i) => (i === index ? reconcileGrid(q, { ...q, ...edit }) : q)),
    )
  }

  function pickOffset(index: number, next: string) {
    patchQuestion(index, {
      schedule: { ...questions[index].schedule, timezone: next },
      offsetPicked: true,
    })
  }

  /**
   * New days, with the offset following them while it is still a guess (this
   * browser's offset on the first day, not today's). Done here rather than in
   * an effect to avoid a state loop.
   */
  function pickDays(index: number, next: string[], marked: Set<GranuleKey>) {
    const question = questions[index]
    const on = [...next].sort()[0]
    const timezone = !question.offsetPicked && on ? viewerOffsetOn(on) : question.schedule.timezone

    patchQuestion(index, {
      days: next,
      marked,
      schedule: { ...question.schedule, timezone },
      datesMoved: 0,
    })
  }

  function addQuestion() {
    const added = blankQuestion()
    setQuestions((prev) => [...prev, added])
    setOpenKey(added.key)
  }

  function removeQuestion(index: number) {
    const left = questions.filter((_, i) => i !== index)
    // Move off a removed open tab to its left neighbour. Set outside the
    // updater, which StrictMode calls twice.
    if (questions[index]?.key === openKey) {
      setOpenKey(left[Math.max(0, index - 1)]?.key ?? null)
    }
    setQuestions(left)
    // One question left is a poll asking one; unlike the switch, this keeps
    // whichever question was not removed.
    if (left.length < 2) setMultiQuestion(false)
  }

  /** On adds an empty second question; off keeps question 1 and drops the rest. */
  function toggleMultiQuestion(on: boolean) {
    setMultiQuestion(on)
    if (on) {
      setQuestions((prev) => (prev.length >= 2 ? prev : [...prev, blankQuestion()]))
    } else {
      setQuestions((prev) => prev.slice(0, 1))
    }
  }

  // Hiding a description discards it, so a poll never carries one its creator can't see.
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
    if (hasErrors(errors)) {
      // Open the first tab with a problem, then focus the first invalid field
      // (two frames, once the errors and tab are rendered). Errors not on a
      // field are announced instead.
      if (multiQuestion) {
        const firstBad = questions.findIndex((_, index) => questionHasError(errors, index))
        if (firstBad >= 0) setOpenKey(questions[firstBad].key)
      }
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const first = document.querySelector<HTMLElement>('main [aria-invalid="true"]')
          if (first) first.focus()
          else announce('Some of the form needs fixing before the poll can be made')
        }),
      )
      return
    }

    // A time question's options are its enumerated windows, sent as ordinary
    // options. Blank option rows are dropped, with their descriptions.
    const cleaned = questions.map((question) => {
      if (!isTimeQuestion(question)) {
        return {
          title: question.title.trim(),
          kind: question.kind,
          kind_value: kindValueOf(question),
          schedule: null,
          carried: carriedOf(question, isOpen),
          options: question.options
            .map((o) => ({
              name: o.name.trim(),
              description: o.description?.trim() || null,
              number: numberOf(question, o),
            }))
            .filter((o) => o.name),
        }
      }
      // Days that have gone (e.g. form left open past midnight) are dropped,
      // as `validate` counted.
      const marked = fromDay(question.marked, todayIn(question.schedule.timezone))
      const grid = settle(gridOf(question), marked, question.hours)
      return {
        title: question.title.trim(),
        kind: question.kind,
        kind_value: kindValueOf(question),
        schedule: grid,
        carried: carriedOf(question, isOpen),
        options: enumerateWindows(grid, marked).map((name) => ({
          name,
          description: null,
          // An assignment's windows each carry the places per time.
          number: question.kind === 'assignment' ? (grid.places ?? null) : null,
        })),
      }
    })

    const typedEmails = emails.map((e) => e.trim().toLowerCase()).filter(Boolean)
    const allEmails = Array.from(new Set(includeSelf ? [...typedEmails, myEmail] : typedEmails))
    const only = cleaned[0]

    setSubmitting(true)
    // One transaction either way, so a failure leaves no half-built poll.
    const { data, error: rpcError } = multiQuestion
      ? await supabase.rpc('create_poll_group', {
          p_title: title.trim(),
          // Required (no DEFAULT in SQL); '' and null end up the same.
          p_description: description.trim(),
          // Each option's number goes as what its kind calls it: `cost` or `places`.
          p_questions: cleaned.map(({ options, ...question }) => {
            const numbered = optionNumberOf(question.kind)
            return {
              ...question,
              options: options.map(({ number, ...o }) =>
                numbered ? { ...o, [numbered]: number } : o,
              ),
            }
          }),
          p_emails: isOpen ? [] : allEmails,
          p_mode: mode,
          p_show_voters: votersShown,
          p_show_ballots: publishBallots,
          p_solicit_options: solicitOptions,
        })
      : await supabase.rpc('create_poll', {
          p_title: title.trim(),
          p_description: description.trim(),
          p_options: only.options.map((o) => o.name),
          p_emails: isOpen ? [] : allEmails,
          p_mode: mode,
          p_show_voters: votersShown,
          p_show_ballots: publishBallots,
          p_solicit_options: solicitOptions,
          p_carried: only.carried ?? undefined,
          p_kind: only.kind,
          p_schedule: only.schedule ?? undefined,
          p_kind_value: only.kind_value ?? undefined,
          // Omitted when nothing is described. '' stands for none: the SQL
          // nullifies blanks, and `text[]` can't type nullable elements.
          p_option_descriptions: only.options.some((o) => o.description)
            ? only.options.map((o) => o.description ?? '')
            : undefined,
          // A budget's costs or an assignment's places, paired by position
          // like the descriptions. `numeric[]` can't type nullable elements
          // either, but the SQL reads a null place as one.
          p_option_costs:
            only.kind === 'budget'
              ? only.options.map((o) => o.number ?? 0)
              : only.kind === 'assignment'
                ? (only.options.map((o) => o.number) as number[])
                : undefined,
        })
    setSubmitting(false)

    if (rpcError) {
      setError(rpcError.message)
      return
    }

    notifications.show({ message: 'Poll created', color: 'green' })
    savePollDefaults({
      // Without an account the mode was not a choice, so the saved one stands.
      mode: anonymous ? defaults.mode : mode,
      showVoters,
      showBallots: publishBallots,
      solicitOptions,
      multiQuestion,
    })
    // The new poll's heading is fully known, so hand it over like a list card
    // does; the title flies from the field to the page. See lib/headingFlight.ts.
    const id = data as string
    const heading: PollHeadingProps = {
      title: title.trim(),
      description: description.trim() || null,
      createdBy: 'you',
      mode,
      showVoters: votersShown,
      showBallots: publishBallots,
      turnout: {
        soliciting: solicitOptions,
        mode,
        votedCount: 0,
        invitedCount: isOpen ? 0 : allEmails.length,
        confirmedCount: 0,
        optionCount: only.options.length,
        questionCount: cleaned.length,
      },
      state: {
        soliciting: solicitOptions,
        resultsAvailable: false,
        closed: false,
        inGroup: multiQuestion,
      },
    }
    launchTitleFlight(id, titleField.current)
    navigate(pollPath(id), { state: { title: heading.title, heading } })
  }

  /**
   * What the question asks for (`kind`), and its number where it takes one.
   * The number is a dropdown rather than a number field: the database counts
   * at most `SCORING_ROWS_MAX` of anything, so there are ten answers at most. What
   * each choice does is explained on `/choices`, behind the info icon, which
   * opens in a new tab so the form is not lost.
   */
  function choiceFields(question: QuestionDraft, questionIndex: number) {
    const number = CHOICE_NUMBER[question.kind]
    const timed = isTimeQuestion(question)
    const id = `choice-${question.key}`
    const budget = question.kind === 'budget'
    const columns = 1 + (question.sequential ? 1 : 0) + (number || budget ? 1 : 0)

    // Sequential is a choice of its own with a type under it; the type is
    // the question's kind, so a sequential best time is still a time poll.
    const choose = (value: string) =>
      value === SEQUENTIAL
        ? patchQuestion(questionIndex, {
            sequential: true,
            kind: SEQUENTIAL_KINDS.includes(question.kind) ? question.kind : 'option',
          })
        : patchQuestion(questionIndex, { sequential: false, kind: value as PollKind })

    return (
      <SimpleGrid cols={{ base: 1, xs: columns }} spacing="xs">
        <Stack gap={2}>
          <Group gap={4} wrap="nowrap">
            <Text component="label" htmlFor={id} size="sm" fw={500}>
              Choice type
            </Text>
            <Popover width={260} position="bottom-start" withArrow shadow="md" trapFocus>
              <Popover.Target>
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  size="sm"
                  radius="xl"
                  aria-label="What each choice does"
                >
                  <InfoIcon size={16} aria-hidden />
                </ActionIcon>
              </Popover.Target>
              <Popover.Dropdown>
                {/* A new tab, so the form being filled in survives. */}
                <Text size="sm">
                  Visit the{' '}
                  <Anchor component={Link} to="/choices" target="_blank" inherit>
                    list of choices
                  </Anchor>{' '}
                  to learn about what these options mean.
                </Text>
              </Popover.Dropdown>
            </Popover>
          </Group>
          <Select
            id={id}
            allowDeselect={false}
            value={question.sequential ? SEQUENTIAL : question.kind}
            onChange={(v) => v && choose(v)}
            data={[
              // On a calendar each reads as times, and a budget is not on
              // offer: a meeting time is not something anybody buys.
              ...CHOICE_ORDER.map((kind) => ({
                value: kind,
                label: choiceLabel(kind, timed),
                disabled: question.calendar && !canBeCalendar(kind),
              })),
              { value: SEQUENTIAL, label: 'Sequential poll' },
            ]}
          />
        </Stack>
        {question.sequential && (
          <Stack gap={2} justify="flex-end">
            <Select
              label="Sequential poll type"
              allowDeselect={false}
              value={question.kind}
              onChange={(v) => v && patchQuestion(questionIndex, { kind: v as PollKind })}
              data={SEQUENTIAL_KINDS.map((kind) => ({
                value: kind,
                label: choiceLabel(kind, timed),
              }))}
            />
          </Stack>
        )}
        {number && (
          // Its label sits on the choice's label row, so the two boxes line up.
          <Stack gap={2} justify="flex-end">
            <Select
              label={choiceNumberLabel(question.kind, timed)}
              allowDeselect={false}
              value={String(question.kindNumbers[question.kind] ?? number.numbers.at(-1))}
              onChange={(v) =>
                v &&
                patchQuestion(questionIndex, {
                  kindNumbers: { ...question.kindNumbers, [question.kind]: Number(v) },
                })
              }
              data={number.numbers.map((n) => String(n))}
            />
          </Stack>
        )}
        {budget && (
          // A number field rather than a dropdown: a budget is any amount, in
          // whatever unit the poll is about, so it says none.
          <Stack gap={2} justify="flex-end">
            <NumberInput
              label="Budget"
              placeholder="How much there is to spend"
              value={question.budget}
              onChange={(v) => patchQuestion(questionIndex, { budget: v })}
              min={1}
              max={AMOUNT_MAX}
              allowDecimal={false}
              allowNegative={false}
              thousandSeparator=","
              error={shown.budgets[questionIndex]}
            />
          </Stack>
        )}
      </SimpleGrid>
    )
  }

  /**
   * *Find a time*: whether the options are written or painted on a calendar.
   * A setting of the ballot rather than another *Choice*, so every result
   * can be asked of a meeting time; a budget is the one that cannot, and
   * while it is chosen the switch says why.
   */
  function calendarSwitch(question: QuestionDraft, questionIndex: number) {
    const allowed = canBeCalendar(question.kind)
    return (
      <Switch
        checked={isTimeQuestion(question)}
        disabled={!allowed}
        onChange={(e) => patchQuestion(questionIndex, { calendar: e.currentTarget.checked })}
        label="Find a time"
        description={
          allowed
            ? 'Voters mark a calendar instead of scoring a written list.'
            : 'A proportional budget buys its options, and a meeting time is not bought.'
        }
      />
    )
  }

  /** One question's fields, the same whether in a tab panel or the bare form. */
  function questionFields(question: QuestionDraft, questionIndex: number) {
    return (
      <Stack gap="xs">
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

        {calendarSwitch(question, questionIndex)}

        {choiceFields(question, questionIndex)}

        {question.sequential && (
          <CarriedVoters
            rows={question.carried}
            isOpen={isOpen}
            onChange={(rows) => patchQuestion(questionIndex, { carried: rows })}
            listError={shown.carried[questionIndex]}
            voterError={(i) => shown.carriedVoters[optionKey(questionIndex, i)]}
            givenError={(i) => shown.carriedGiven[optionKey(questionIndex, i)]}
          />
        )}

        {isTimeQuestion(question) ? (
          <>
            {question.datesMoved > 0 && (
              <Alert color="blue" title="These dates have moved">
                The poll you copied is in the past, so this one asks about the same days of the week{' '}
                {question.datesMoved === 1 ? 'a week' : `${question.datesMoved} weeks`} later. Mark
                different days on the calendar below if that is not where you want it.
              </Alert>
            )}
            {solicitOptions && (
              <Text size="xs" c="dimmed">
                Voters will be able to add more times to the calendar later.
              </Text>
            )}
            {question.kind === 'assignment' && (
              // One number for every window, since there is no row to type
              // one beside; kept in the schedule for windows added later.
              <NumberInput
                label="Places per time"
                description="How many voters each time can go to. Voters will not see it."
                placeholder="1"
                value={question.placesPerTime}
                onChange={(v) => patchQuestion(questionIndex, { placesPerTime: v })}
                min={1}
                max={AMOUNT_MAX}
                allowDecimal={false}
                allowNegative={false}
                thousandSeparator=","
                error={shown.places[questionIndex]}
              />
            )}
            <ScheduleFields
              schedule={gridOf(question)}
              overlap={overlapOf(question)}
              several={picksSeveral(question.kind)}
              count={countWindows(
                gridOf(question),
                fromDay(question.marked, todayIn(question.schedule.timezone)),
              )}
              onLengthChange={(minutes) => {
                const granularity = granularityFor(minutes)
                patchQuestion(questionIndex, {
                  schedule: {
                    ...question.schedule,
                    granularity,
                    desired_slots: minutes / granularity,
                  },
                })
              }}
              onOverlapChange={(next) => patchQuestion(questionIndex, { overlap: next })}
              days={question.days}
              hours={question.hours}
              marked={question.marked}
              onDaysChange={(next, marked) => pickDays(questionIndex, next, marked)}
              onHoursChange={(next) => patchQuestion(questionIndex, { hours: next })}
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
              {question.kind === 'budget' &&
                ' Give every option a cost. Voters will not see the costs.'}
              {question.kind === 'assignment' &&
                ' Give an option more places to let it go to more than one voter; a blank one has one place. Voters will not see the places.'}
            </Text>

            {question.options.map((option, index) => (
              <div
                key={option.key}
                className={`${listRow.row} ${option.key === arriving ? listRow.joining : ''} ${
                  leaving.has(option.key) ? listRow.leaving : ''
                }`}
                // Only on a leaving row, so the entrance's end isn't mistaken for it.
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
                      autoFocus={option.key === arriving}
                      id={optionNameId(option.key)}
                      enterKeyHint="next"
                      onKeyDown={(e) => onOptionEnter(e, questionIndex, index)}
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
                        enterKeyHint="next"
                        onKeyDown={(e) => onOptionEnter(e, questionIndex, index)}
                      />
                    )}
                  </Stack>
                  {optionNumberOf(question.kind) && (
                    // Voters never see it: they rate each option on its own
                    // merits, and the count weighs the cost or fills the places.
                    <NumberInput
                      w={110}
                      value={option.number}
                      onChange={(v) => updateOption(questionIndex, index, { number: v })}
                      placeholder={question.kind === 'budget' ? 'Cost' : 'Places'}
                      aria-label={`Option ${index + 1} ${question.kind === 'budget' ? 'cost' : 'places'}`}
                      min={1}
                      max={AMOUNT_MAX}
                      allowDecimal={false}
                      allowNegative={false}
                      thousandSeparator=","
                      hideControls
                      error={shown.optionNumbers[optionKey(questionIndex, index)]}
                    />
                  )}
                  <DescriptionToggle
                    open={option.description !== null}
                    subject={`option ${index + 1}`}
                    onToggle={() => toggleDescription(questionIndex, index)}
                  />
                  <ActionIcon
                    variant="subtle"
                    color="red"
                    onClick={() => removeOption(questionIndex, option.key)}
                    aria-label="Remove option"
                  >
                    &times;
                  </ActionIcon>
                </Group>
              </div>
            ))}

            {shown.options[questionIndex] && (
              <Text c="var(--mantine-color-error)" size="sm">
                {shown.options[questionIndex]}
              </Text>
            )}
          </>
        )}

        {/* Removing a question is a named button at the foot of the question,
            kept apart from the option rows' × so the two never look alike. */}
        <Group gap="sm" align="center" justify="space-between">
          {isTimeQuestion(question) ? (
            <span />
          ) : (
            <Button
              variant="light"
              size="xs"
              onClick={() => addOption(questionIndex)}
              disabled={question.options.length >= MAX_OPTIONS}
              leftSection={<PlusIcon size={14} aria-hidden />}
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
              leftSection={<TrashIcon size={14} aria-hidden />}
            >
              Remove question
            </Button>
          )}
        </Group>
      </Stack>
    )
  }

  if (prefilling) return <FormSkeleton />

  if (datePick) {
    return (
      <DuplicateDates
        from={datePick.from}
        suggested={datePick.suggested}
        today={datePick.today}
        onPick={(first) => {
          // Every time question moves by the same days from where it was
          // copied, so their spacing holds.
          setQuestions((prev) =>
            prev.map((question) => {
              const copied = datePick.copied.get(question.key)
              if (!isTimeQuestion(question) || !copied) return question
              const marked = startingOn(copied, first, datePick.from)
              return { ...question, marked, days: daysOf(marked), datesMoved: 0 }
            }),
          )
          setDatePick(null)
        }}
      />
    )
  }

  return (
    <Stack maw={720} mx="auto" gap="md">
      <Title order={1} size="h2" ta="center">
        {sequel ? 'Sequel poll' : duplicateOf ? 'Duplicate poll' : 'New poll'}
      </Title>

      <Stack gap={2}>
        <Title order={2} size="h4" id="poll-title-label">
          Title
          <span aria-hidden="true" style={{ color: 'var(--mantine-color-red-6)' }}>
            {' *'}
          </span>
        </Title>
        <TextInput
          ref={titleField}
          placeholder="A title for your poll"
          value={title}
          onChange={(e) => setTitle(e.currentTarget.value)}
          aria-labelledby="poll-title-label"
          error={shown.title}
          required
        />
      </Stack>

      <Stack gap={2}>
        <Title order={2} size="h4" id="poll-title-description">
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
        <Title order={2} size="h4">
          Voters
        </Title>
        <Card withBorder p="sm">
          <Stack gap="xs">
            <SegmentedControl
              value={mode}
              onChange={(v) => setMode(v as PollMode)}
              data={[
                { value: 'invite', label: 'Invited people', disabled: anonymous },
                { value: 'open', label: 'Anyone with the link' },
              ]}
            />
            {anonymous && (
              <Text size="sm" c="dimmed">
                <Anchor component={Link} to="/sign-in" state={{ from: '/new' }}>
                  Sign in
                </Anchor>{' '}
                to invite people by email.
              </Text>
            )}
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
                  // A phone keyboard inside a form labels its key "Next" and
                  // moves to the next field without sending Enter, which is
                  // what adds an address. Asking for Enter gets one, so a list
                  // can be typed without leaving the box. The rest keeps the
                  // keyboard from capitalising or correcting an address.
                  enterKeyHint="enter"
                  inputMode="email"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
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
        <Title order={2} size="h4">
          Configuration
        </Title>
        <Card withBorder p="sm">
          <Stack gap="sm">
            {anySequential ? (
              <Switch
                checked={votersShown}
                disabled={anyAssignment}
                onChange={(e) => {
                  setShowVoters(e.currentTarget.checked)
                  setShowBallots(e.currentTarget.checked)
                }}
                label={
                  mode === 'invite'
                    ? 'Show voter emails and publish ballots'
                    : 'Show voter names and publish ballots'
                }
                description={anyAssignment ? ASSIGNMENT_SHOWS_VOTERS : undefined}
              />
            ) : (
              <>
                <Switch
                  checked={votersShown}
                  disabled={anyAssignment}
                  onChange={(e) => setShowVoters(e.currentTarget.checked)}
                  label={mode === 'invite' ? 'Show voter emails' : 'Show voter names'}
                  description={anyAssignment ? ASSIGNMENT_SHOWS_VOTERS : undefined}
                />

                <Switch
                  checked={showBallots}
                  onChange={(e) => setShowBallots(e.currentTarget.checked)}
                  label="Publish ballots"
                />
              </>
            )}

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
        <Title order={2} size="h4">
          {sectionTitle}
        </Title>
        <Card withBorder p="sm">
          <Stack gap="sm">
            {multiQuestion ? (
              /* One question per tab, mirroring QuestionStrip on the voting
                 side. Every question is validated regardless, and a tab with
                 a problem is marked. */
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
                  {/* Never the open tab: pressing it adds a question and opens that. */}
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
              questionFields(questions[0], 0)
            )}
          </Stack>
        </Card>
      </Stack>

      {error && (
        <Text role="alert" c="red" size="sm">
          {error}
        </Text>
      )}

      <Group justify="flex-end">
        <Button
          onClick={handleSubmit}
          loading={submitting}
          leftSection={
            duplicateOf ? <CopyIcon size={16} aria-hidden /> : <PlusIcon size={16} aria-hidden />
          }
        >
          {sequel ? 'Create sequel' : duplicateOf ? 'Create copy' : 'Create poll'}
        </Button>
      </Group>
    </Stack>
  )
}
