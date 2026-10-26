import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { CopyIcon, PlusIcon, TrashIcon } from '@phosphor-icons/react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import {
  ActionIcon,
  Alert,
  Anchor,
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
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { useAuth } from '../lib/auth'
import { supabase } from '../lib/supabase'
import { DescriptionField, DescriptionToggle } from '../components/DescriptionField'
import { ScheduleFields } from '../components/ScheduleFields'
import {
  boundsOf,
  carryForward,
  daysOf,
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
import { pollScheduleSchema } from '../lib/rpcSchemas'
import {
  blankOption,
  blankQuestion,
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
import styles from './CreatePoll.module.css'
import listRow from '../components/listRow.module.css'
import { MAX_OPTIONS, MAX_QUESTIONS } from '../lib/limits'
import { pollIdFromParam, pollPath } from '../lib/pollId'
import type { Invitee, Poll, PollKind, PollMode, PollOption } from '../lib/types'
import { usePageTitle } from '../lib/pageTitle'
import { announce } from '../lib/announce'

/** The `+` tab's value. Question keys are `question-N`, so it cannot collide. */
const ADD_QUESTION = 'add-question'

/** An option's name field, for moving the cursor to it. */
const optionNameId = (key: string) => `option-name-${key}`

export function CreatePoll() {
  usePageTitle('New poll')
  const { session, anonymous } = useAuth()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const fromParam = searchParams.get('from')
  const duplicateOf = fromParam && pollIdFromParam(fromParam)

  const [title, setTitle] = useState('')
  // Where a new poll's title flies from.
  const titleField = useRef<HTMLInputElement>(null)
  const [description, setDescription] = useState('')
  const [questions, setQuestions] = useState<QuestionDraft[]>([blankQuestion()])
  // The option row just added (for its entrance and the cursor), and rows
  // animating out.
  const [arriving, setArriving] = useState<string | null>(null)
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set())
  const [multiQuestion, setMultiQuestion] = useState(false)
  // The wished-for tab; see `openQuestion` for what is actually shown.
  const [openKey, setOpenKey] = useState<string | null>(null)
  // Without an account a poll can only be open (an invite poll sends email).
  const [mode, setMode] = useState<PollMode>(anonymous ? 'open' : 'invite')
  const [showVoters, setShowVoters] = useState(false)
  const [showBallots, setShowBallots] = useState(false)
  const [solicitOptions, setSolicitOptions] = useState(false)
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
        const blank = blankQuestion()
        const parsed = row.kind === 'time' ? pollScheduleSchema.safeParse(row.schedule) : null
        const grid = parsed?.success ? parsed.data : null

        if (row.kind === 'time') {
          if (!grid) {
            setError(
              "That poll's calendar could not be read, so this copy has its title and settings but none of its times. Mark the days and hours below.",
            )
            return { ...blank, title: row.question_title ?? '', kind: 'time' }
          }

          // Read the painting off the options, then move it forward whole
          // weeks past today (on the poll's clock).
          const copied = boundsOf(
            rows.map((option) => option.name),
            grid,
          )
          const renewed = carryForward(copied, todayIn(grid.timezone))
          if (copied.size > 0) {
            copiedTimes.set(blank.key, copied)
            clock.today ??= todayIn(grid.timezone)
          }
          return {
            ...blank,
            title: row.question_title ?? '',
            kind: 'time',
            // The source's offset is a choice, so later date changes must not move it.
            schedule: grid,
            offsetPicked: true,
            marked: renewed.bounds,
            days: daysOf(renewed.bounds),
            hours: grid.window,
            datesMoved: renewed.weeks,
          }
        }

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
        // `poll_invitees` raises on open polls.
        const { data: inviteeData } = await supabase.rpc('poll_invitees', {
          p_poll_id: sourceId,
        })
        if (cancelled) return
        const allEmails = ((inviteeData as Invitee[]) ?? []).map((i) => i.email)
        // The creator's own address is the checkbox, not a tag.
        setIncludeSelf(allEmails.includes(myEmail))
        setEmails(allEmails.filter((e) => e !== myEmail))
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
  }, [duplicateOf, myEmail])

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

  function patchQuestion(index: number, edit: Partial<QuestionDraft>) {
    setQuestions((prev) => prev.map((q, i) => (i === index ? { ...q, ...edit } : q)))
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
      // Days that have gone (e.g. form left open past midnight) are dropped,
      // as `validate` counted.
      const marked = fromDay(question.marked, todayIn(question.schedule.timezone))
      const grid = settle(question.schedule, marked)
      return {
        title: question.title.trim(),
        kind: 'time' as const,
        schedule: grid,
        options: enumerateWindows(grid, marked).map((name) => ({
          name,
          description: null,
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
          p_schedule: only.schedule ?? undefined,
          // Omitted when nothing is described. '' stands for none: the SQL
          // nullifies blanks, and `text[]` can't type nullable elements.
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
    // The new poll's heading is fully known, so hand it over like a list card
    // does; the title flies from the field to the page. See lib/headingFlight.ts.
    const id = data as string
    const heading: PollHeadingProps = {
      title: title.trim(),
      description: description.trim() || null,
      createdBy: 'you',
      mode,
      showVoters,
      showBallots,
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

        <SegmentedControl
          fullWidth
          value={question.kind}
          onChange={(v) => patchQuestion(questionIndex, { kind: v as PollKind })}
          data={[
            { value: 'option', label: 'Choose an option' },
            { value: 'time', label: 'Find a time' },
          ]}
        />

        {question.kind === 'time' ? (
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
          {question.kind === 'time' ? (
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
              if (question.kind !== 'time' || !copied) return question
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
        {duplicateOf ? 'Duplicate poll' : 'New poll'}
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
          {duplicateOf ? 'Create copy' : 'Create poll'}
        </Button>
      </Group>
    </Stack>
  )
}
