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
  OPTION_DESCRIPTION_MAX,
  OPTION_NAME_MAX,
  POLL_DESCRIPTION_MAX,
  TITLE_MAX,
  tooLong,
} from '../lib/limits'
import type { Invitee, Poll, PollMode, PollOption } from '../lib/types'

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
  options?: string
  optionNames: Record<number, string>
  optionDescriptions: Record<number, string>
}

function hasErrors(errors: FormErrors): boolean {
  return Boolean(
    errors.title ||
    errors.description ||
    errors.emails ||
    errors.options ||
    Object.keys(errors.optionNames).length ||
    Object.keys(errors.optionDescriptions).length,
  )
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
  options: OptionDraft[]
  emails: string[]
  includeSelf: boolean
  myEmail: string
  isOpen: boolean
  solicitOptions: boolean
}): FormErrors {
  const errors: FormErrors = { optionNames: {}, optionDescriptions: {} }

  const title = form.title.trim()
  if (!title) errors.title = 'Give the poll a title.'
  else if (title.length > TITLE_MAX) errors.title = tooLong('A title', title.length, TITLE_MAX)

  const description = form.description.trim()
  if (description.length > POLL_DESCRIPTION_MAX) {
    errors.description = tooLong('A description', description.length, POLL_DESCRIPTION_MAX)
  }

  // Compared lowercased: two options that differ only in case are one
  // option to everybody scoring the ballot, and the suggestion path has
  // always refused the pair for that reason.
  const seen = new Map<string, number>()
  form.options.forEach((option, index) => {
    const name = option.name.trim()
    if (name.length > OPTION_NAME_MAX) {
      errors.optionNames[index] = tooLong('An option name', name.length, OPTION_NAME_MAX)
    } else if (name) {
      const first = seen.get(name.toLowerCase())
      // Reported against the later row: the first one is the one that keeps
      // the name, so it is not the one that has to change.
      if (first !== undefined) errors.optionNames[index] = `Same as option ${first + 1}.`
      else seen.set(name.toLowerCase(), index)
    }

    const optionDescription = option.description?.trim() ?? ''
    if (optionDescription.length > OPTION_DESCRIPTION_MAX) {
      errors.optionDescriptions[index] = tooLong(
        'A description',
        optionDescription.length,
        OPTION_DESCRIPTION_MAX,
      )
    }
  })

  const filled = form.options.filter((o) => o.name.trim()).length
  // A poll that collects its options may be created with none: the same
  // minimum is applied later, when the creator turns the list into a ballot.
  // Seeding a few here is a head start, not a requirement.
  if (!form.solicitOptions && filled < 2) {
    errors.options = 'A poll needs at least two options.'
  } else if (filled > MAX_OPTIONS) {
    errors.options = `A ballot can only hold ${MAX_OPTIONS} options; this one has ${filled}.`
  }

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
  const [options, setOptions] = useState<OptionDraft[]>([blankOption(), blankOption()])
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
    options,
    emails,
    includeSelf,
    myEmail,
    isOpen,
    solicitOptions,
  })
  // What the fields actually render. Held back until the first submit, then
  // live: fixing a field clears its message as it is fixed.
  const shown: FormErrors = showErrors ? errors : { optionNames: {}, optionDescriptions: {} }

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
      const sourceOptions = ((optionsRes.data as PollOption[]) ?? []).map((o) => ({
        name: o.name,
        description: o.description,
      }))
      // Keep the form's two-row minimum if the source somehow had fewer.
      setOptions(
        sourceOptions.length >= 2
          ? sourceOptions
          : [...sourceOptions, blankOption(), blankOption()].slice(0, 2),
      )

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

  function updateOption(index: number, patch: Partial<OptionDraft>) {
    setOptions((prev) => prev.map((o, i) => (i === index ? { ...o, ...patch } : o)))
  }

  function addOption() {
    setOptions((prev) => [...prev, blankOption()])
  }

  function removeOption(index: number) {
    setOptions((prev) => prev.filter((_, i) => i !== index))
  }

  // null is "no description", and is also what collapses the field: showing a
  // description means giving it an empty string to type into, and hiding one
  // throws whatever was in it away. Keeping hidden text would mean a poll
  // could carry a description its creator can no longer see, which is the one
  // way this field could surprise anybody.
  function toggleDescription(index: number) {
    setOptions((prev) =>
      prev.map((o, i) =>
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
    if (hasErrors(errors)) return

    // Blank rows are dropped here and in create_poll alike, and the
    // descriptions travel as a parallel array; so they are filtered
    // together, never separately, or a dropped row would slide every later
    // description onto the wrong option.
    const cleanOptions = options
      .map((o) => ({ name: o.name.trim(), description: o.description?.trim() || null }))
      .filter((o) => o.name)
    const typedEmails = emails.map((e) => e.trim().toLowerCase()).filter(Boolean)
    const allEmails = Array.from(new Set(includeSelf ? [...typedEmails, myEmail] : typedEmails))

    setSubmitting(true)
    // One transaction: the poll, its options, and its invitees land together
    // or not at all.
    const { data, error: rpcError } = await supabase.rpc('create_poll', {
      p_title: title.trim(),
      p_description: description.trim() || null,
      p_options: cleanOptions.map((o) => o.name),
      p_emails: isOpen ? [] : allEmails,
      p_mode: mode,
      p_show_voters: showVoters,
      p_show_ballots: showBallots,
      p_solicit_options: solicitOptions,
      // Most polls describe nothing, and send nothing rather than a row of
      // nulls the database would only throw away again.
      p_option_descriptions: cleanOptions.some((o) => o.description)
        ? cleanOptions.map((o) => o.description)
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
              <Text size="sm">One person can vote more than once by using another browser.</Text>
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
      <Switch
        checked={solicitOptions}
        onChange={(e) => setSolicitOptions(e.currentTarget.checked)}
        label="Solicit options from voters"
      />

      {/* Last, because it is the only part of the form whose shape depends on
          the answers above it: a poll collecting its options can be created
          with none at all, and the rows here become a head start rather than
          the ballot. */}
      <Stack gap="xs">
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
        {options.map((option, index) => (
          <Group key={index} gap="xs" align="flex-start" wrap="nowrap">
            <Stack gap={4} style={{ flex: 1 }}>
              <TextInput
                value={option.name}
                onChange={(e) => updateOption(index, { name: e.currentTarget.value })}
                placeholder={`Option ${index + 1}`}
                error={shown.optionNames[index]}
              />
              {option.description !== null && (
                <DescriptionField
                  value={option.description}
                  onChange={(e) => updateOption(index, { description: e.currentTarget.value })}
                  placeholder={`Option ${index + 1} description`}
                  error={shown.optionDescriptions[index]}
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
                onClick={() => toggleDescription(index)}
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
              onClick={() => removeOption(index)}
              /* Two rows is the floor for a poll that ships its options with
                 it, and no floor at all for one that collects them. */
              disabled={!solicitOptions && options.length <= 2}
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
            onClick={addOption}
            w="fit-content"
            disabled={options.length >= MAX_OPTIONS}
          >
            Add option
          </Button>
        </Group>
        {/* Wrong with the list rather than with a row in it, so it sits under
            the list rather than under any one field. */}
        {shown.options && (
          <Text c="var(--mantine-color-error)" size="sm">
            {shown.options}
          </Text>
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
