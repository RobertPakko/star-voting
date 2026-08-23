import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  ActionIcon,
  Alert,
  Button,
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
import { FormSkeleton } from '../components/Skeletons'
import {
  MAX_OPTIONS,
  MAX_QUESTIONS,
  OPTION_DESCRIPTION_MAX,
  OPTION_NAME_MAX,
  POLL_DESCRIPTION_MAX,
  TITLE_MAX,
  tooLong,
} from '../lib/limits'
import type { GroupQuestion, Invitee, Poll, PollMode, PollOption } from '../lib/types'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * One row of the options list. `description` is null when the option has no
 * description field on screen at all, which is the state nearly every option
 * in nearly every poll stays in.
 */
interface OptionDraft {
  name: string
  description: string | null
}

function blankOption(): OptionDraft {
  return { name: '', description: null }
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
  return { key: `question-${questionSeq}`, title: '', options: [blankOption(), blankOption()] }
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
  if (errors.questionTitles[questionIndex] || errors.options[questionIndex]) return true
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
    Object.keys(errors.questionTitles).length ||
    Object.keys(errors.options).length ||
    Object.keys(errors.optionNames).length ||
    Object.keys(errors.optionDescriptions).length,
  )
}

/** An empty set of messages: what the fields render before the first submit. */
function noErrors(): FormErrors {
  return { questionTitles: {}, options: {}, optionNames: {}, optionDescriptions: {} }
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
  const [multiQuestion, setMultiQuestion] = useState(false)
  // Which question's fields are on screen, by key rather than by position;
  // see QuestionDraft.key. Never trusted on its own: what is rendered is
  // `openQuestion` below, which falls back to the first question whenever
  // this points at one that is no longer in the list — which is what happens
  // when a duplicate replaces the whole list, and when the open tab is the
  // one being removed.
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [mode, setMode] = useState<PollMode>('invite')
  const [showVoters, setShowVoters] = useState(true)
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

  // Duplicating copies the source poll's settings into the form and stops
  // there; nothing is created until the user submits, so the copy can be
  // edited first. Read through the same RLS and RPCs as everywhere else, so
  // it can only ever duplicate a poll the user can already see.
  useEffect(() => {
    if (!duplicateOf) return
    let cancelled = false

    async function prefill(sourceId: string) {
      const [pollRes, optionsRes] = await Promise.all([
        supabase.from('polls').select('*').eq('id', sourceId).single(),
        supabase.from('candidates').select('*').eq('poll_id', sourceId).order('sort_order'),
      ])
      if (cancelled) return

      if (pollRes.error) {
        setError(`Couldn't load the poll to duplicate: ${pollRes.error.message}`)
        setPrefilling(false)
        return
      }

      const source = pollRes.data as Poll
      setTitle(source.title)
      setDescription(source.description ?? '')
      setMode(source.mode)
      setShowVoters(source.show_voters)
      setShowBallots(source.show_ballots)
      setSolicitOptions(source.solicit_options)

      // Descriptions come across with their options, so a duplicate of a poll
      // that explained its options does not quietly lose the explanations.
      const draftFrom = (rows: PollOption[]): OptionDraft[] => {
        const drafted = rows.map((o) => ({ name: o.name, description: o.description }))
        // Keep the form's two-row minimum if the source somehow had fewer.
        return drafted.length >= 2
          ? drafted
          : [...drafted, blankOption(), blankOption()].slice(0, 2)
      }

      // A duplicate of a poll that asks several questions is a poll that asks
      // the same several, not whichever one the creator happened to press
      // Duplicate on. The group is read through the same RPC the poll page
      // uses, and every question's options in one query rather than one each.
      const { data: groupData } = await supabase.rpc('poll_group', { p_poll_id: sourceId })
      if (cancelled) return
      const group = (groupData as GroupQuestion[]) ?? []

      if (group.length > 1) {
        const ids = group.map((q) => q.id)
        const { data: allOptions } = await supabase
          .from('candidates')
          .select('*')
          .in('poll_id', ids)
          .order('sort_order')
        if (cancelled) return
        const rows = (allOptions as PollOption[]) ?? []
        setMultiQuestion(true)
        setQuestions(
          group.map((question) => ({
            ...blankQuestion(),
            title: question.question_title,
            options: draftFrom(rows.filter((o) => o.poll_id === question.id)),
          })),
        )
      } else {
        setQuestions([
          { ...blankQuestion(), options: draftFrom((optionsRes.data as PollOption[]) ?? []) },
        ])
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
    patchOptions(question, (options) => [...options, blankOption()])
  }

  function removeOption(question: number, index: number) {
    patchOptions(question, (options) => options.filter((_, i) => i !== index))
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

  function addQuestion() {
    const added = blankQuestion()
    setQuestions((prev) => [...prev, added])
    // Adding a question is asking for somewhere to write one, so the strip
    // goes there. Leaving it on the question being left would make the button
    // look like it had done nothing.
    setOpenKey(added.key)
  }

  function removeQuestion(index: number) {
    setQuestions((prev) => {
      const left = prev.filter((_, i) => i !== index)
      // Removing the question on screen leaves the strip pointing at nothing,
      // so it moves to the one before it — the neighbour the reader was last
      // looking at — or to the first if this was the first.
      if (prev[index]?.key === openKey) {
        setOpenKey(left[Math.max(0, index - 1)]?.key ?? null)
      }
      return left
    })
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

    // Blank rows are dropped here and in the database alike, and the
    // descriptions travel with their option rather than beside it, so a
    // dropped row cannot slide every later description onto the wrong one.
    const cleaned = questions.map((question) => ({
      title: question.title.trim(),
      options: question.options
        .map((o) => ({ name: o.name.trim(), description: o.description?.trim() || null }))
        .filter((o) => o.name),
    }))
    const typedEmails = emails.map((e) => e.trim().toLowerCase()).filter(Boolean)
    const allEmails = Array.from(new Set(includeSelf ? [...typedEmails, myEmail] : typedEmails))

    setSubmitting(true)
    // One transaction either way: the poll, its questions, their options and
    // its invitees land together or not at all. That is the whole reason a
    // group is created by one function rather than by a loop out here -- a
    // failure part-way would leave a real, half-built poll behind, with the
    // invitations for it already sent.
    const { data, error: rpcError } = multiQuestion
      ? await supabase.rpc('create_poll_group', {
          p_title: title.trim(),
          p_description: description.trim() || null,
          p_questions: cleaned,
          p_emails: isOpen ? [] : allEmails,
          p_mode: mode,
          p_show_voters: showVoters,
          p_show_ballots: showBallots,
          p_solicit_options: solicitOptions,
        })
      : await supabase.rpc('create_poll', {
          p_title: title.trim(),
          p_description: description.trim() || null,
          p_options: cleaned[0].options.map((o) => o.name),
          p_emails: isOpen ? [] : allEmails,
          p_mode: mode,
          p_show_voters: showVoters,
          p_show_ballots: showBallots,
          p_solicit_options: solicitOptions,
          // Most polls describe nothing, and send nothing rather than a row of
          // nulls the database would only throw away again.
          p_option_descriptions: cleaned[0].options.some((o) => o.description)
            ? cleaned[0].options.map((o) => o.description)
            : null,
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
        {/* A question of a multi-question poll is titled and can be removed;
            the single question of an ordinary poll is neither, because the
            poll's own title names it and there is nothing to remove it
            from. */}
        {multiQuestion && (
          <Group gap="xs" align="flex-end" wrap="nowrap">
            <TextInput
              label={`Question ${questionIndex + 1}`}
              placeholder="What is this question asking?"
              value={question.title}
              onChange={(e) => updateQuestionTitle(questionIndex, e.currentTarget.value)}
              error={shown.questionTitles[questionIndex]}
              style={{ flex: 1 }}
              required
            />
            <ActionIcon
              variant="subtle"
              color="red"
              onClick={() => removeQuestion(questionIndex)}
              disabled={questions.length <= 2}
              aria-label={`Remove question ${questionIndex + 1}`}
            >
              &times;
            </ActionIcon>
          </Group>
        )}

        <Stack gap={2}>
          <Text fw={500} size="sm">
            {solicitOptions ? 'Starting options' : 'Options'}
          </Text>
          {/* The + is one small icon on a row of them, so it gets one line
              saying what it is for. Most polls need none. */}
          <Text size="xs" c="dimmed">
            {solicitOptions
              ? 'Voters will be able to add to this list later.'
              : 'Use + to add a description to an option.'}
          </Text>
        </Stack>

        {question.options.map((option, index) => (
          <Group key={index} gap="xs" align="flex-start" wrap="nowrap">
            <Stack gap={4} style={{ flex: 1 }}>
              <TextInput
                value={option.name}
                onChange={(e) =>
                  updateOption(questionIndex, index, { name: e.currentTarget.value })
                }
                placeholder={`Option ${index + 1}`}
                error={shown.optionNames[optionKey(questionIndex, index)]}
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
              onClick={() => removeOption(questionIndex, index)}
              /* Two rows is the floor for a poll that ships its options with
             it, and no floor at all for one that collects them. */
              disabled={!solicitOptions && question.options.length <= 2}
              aria-label="Remove option"
            >
              &times;
            </ActionIcon>
          </Group>
        ))}

        <Group gap="sm" align="center">
          <Button
            variant="light"
            size="xs"
            onClick={() => addOption(questionIndex)}
            w="fit-content"
            disabled={question.options.length >= MAX_OPTIONS}
          >
            Add option
          </Button>
        </Group>

        {/* Wrong with the list rather than with a row in it, so it sits under
            the list rather than under any one field. */}
        {shown.options[questionIndex] && (
          <Text c="var(--mantine-color-error)" size="sm">
            {shown.options[questionIndex]}
          </Text>
        )}
      </Stack>
    )
  }

  // Only ever on a duplicate, and only until the source poll comes back:
  // the form it is standing in for is the one being filled in from it.
  if (prefilling) return <FormSkeleton />

  return (
    <Stack maw={560} mx="auto" gap="md">
      <Stack gap={4}>
        <Title order={2}>{duplicateOf ? 'Duplicate poll' : 'New poll'}</Title>
      </Stack>

      <TextInput
        label="Title"
        placeholder="A title for your poll"
        value={title}
        onChange={(e) => setTitle(e.currentTarget.value)}
        error={shown.title}
        required
      />
      <Textarea
        label="Description"
        placeholder="Optional additional details"
        value={description}
        onChange={(e) => setDescription(e.currentTarget.value)}
        error={shown.description}
        autosize
        minRows={2}
      />

      <Stack gap="xs">
        <Text fw={500} size="sm">
          Who can vote
        </Text>
        <SegmentedControl
          value={mode}
          onChange={(v) => setMode(v as PollMode)}
          data={[
            { value: 'invite', label: 'Invited people' },
            { value: 'open', label: 'Anyone with the link' },
          ]}
        />
        <Text size="xs" c="dimmed">
          {isOpen
            ? 'Anyone with the link can see and vote in the poll.'
            : 'Voters must sign in with their email. Only addresses on the invite list can see or vote in the poll.'}
        </Text>
        {isOpen && (
          <Alert color="yellow" title="Unauthenticated">
            <Stack gap={4}>
              <Text size="sm">People can vote more than once by using multiple browsers.</Text>
            </Stack>
          </Alert>
        )}
        {!isOpen && (
          <Stack gap="xs">
            <TagsInput
              description="Type an email and press Enter to add it or paste a comma separated list of emails."
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
          </Stack>
        )}
      </Stack>

      <Switch
        checked={showVoters}
        onChange={(e) => setShowVoters(e.currentTarget.checked)}
        label="Show who has voted"
      />

      {/* Independent of the switch above: this one is about the scores, that
          one about the names. Off gives the behaviour the app has always
          had, so an untouched form still creates a secret-ballot poll. */}
      <Stack gap={4}>
        <Switch
          checked={showBallots}
          onChange={(e) => setShowBallots(e.currentTarget.checked)}
          label="Publish ballots"
        />
        {showBallots && (
          <Text size="xs" c="dimmed">
            Voters are told this on the ballot before they submit it. Like every other poll setting
            it is fixed at creation, so nobody's ballot can be published after the fact.
          </Text>
        )}
      </Stack>

      {/* The one setting that decides what the poll does *before* anyone
          votes. Off is the behaviour the app has always had. */}
      <Stack gap={4}>
        <Switch
          checked={solicitOptions}
          onChange={(e) => setSolicitOptions(e.currentTarget.checked)}
          label="Solicit options from voters"
        />
        {solicitOptions && multiQuestion && (
          <Text size="xs" c="dimmed">
            Each question collects its own options, and opening the poll opens all of them at once.
          </Text>
        )}
      </Stack>

      {/* Below the settings and above the options, because it is what decides
          the shape of everything under it: one option list, or one per
          question. Off is the behaviour the app has always had. */}
      <Stack gap={4}>
        <Switch
          checked={multiQuestion}
          onChange={(e) => toggleMultiQuestion(e.currentTarget.checked)}
          label="Ask several questions"
        />
        <Text size="xs" c="dimmed">
          {multiQuestion
            ? 'Each question is scored on its own ballot and elects its own winner. Voters answer them one after another.'
            : 'One ballot, one winner. Turn this on to ask more than one question in the same poll.'}
        </Text>
      </Stack>

      {/* Last, because it is the only part of the form whose shape depends on
          the answers above it: a poll collecting its options can be created
          with none at all, and the rows here become a head start rather than
          the ballot. */}
      <Stack gap="lg">
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
                  {/* The question's own title once it has one, since that is
                      what a creator coming back to it is looking for; its
                      position until then, because "Question 3" is the only
                      name an empty question has. */}
                  <Text component="span" size="sm" truncate maw={160}>
                    {question.title.trim() || `Question ${questionIndex + 1}`}
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
              <Tabs.Panel key={question.key} value={question.key} pt="md">
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
