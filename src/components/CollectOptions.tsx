import { Fragment, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  ActionIcon,
  Button,
  Card,
  Divider,
  Group,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { supabase } from '../lib/supabase'
import { openPollRpc } from '../lib/samplePoll'
import {
  MAX_OPTIONS,
  OPTION_DESCRIPTION_MAX,
  OPTION_NAME_MAX,
  VOTER_NAME_MAX,
  tooLong,
} from '../lib/limits'
import { voterKeyFor } from '../lib/voterKey'
import { rememberVoterName, rememberedVoterName } from '../lib/voterName'
import { DescriptionField } from './DescriptionField'
import { NameRoster } from './NameRoster'
import { OptionDescription } from './OptionDescription'
import { ConfirmNote, OpeningNote } from './PollNotices'
import type { PollOption } from '../lib/types'

/**
 * Which endpoint an added option goes through.
 *
 * The first two are the suggestion path, and are the same split as
 * ResultsSource and BallotsSource for the same reason: a session proves the
 * caller belongs to an invite poll, the link proves it for an open
 * one. `creator` is the other path entirely; the poll's own creator
 * correcting a list that is already a ballot, on a poll nobody has voted in
 * yet. See 0028_creator_edits_options.sql for why that is allowed and where
 * the window closes.
 *
 * Confirming takes the same two ways in, so it takes the same value: the
 * creator's correction is the one that cannot be confirmed, because a list
 * that is already a ballot has nobody left to be done adding to it.
 */
export type OptionsSource =
  | { kind: 'poll'; pollId: string }
  | { kind: 'open'; pollId: string }
  | { kind: 'creator'; pollId: string }

/**
 * How this reader says they are done with the list, when they have a say in
 * it at all. Absent for the creator correcting a ballot's options, and for an
 * invite poll's creator who did not invite themselves — their "I am done" is
 * *Open poll*, which they have had all along.
 */
export interface Confirmation {
  /** Whether they have already said so; the card draws either way. */
  confirmed: boolean
  /**
   * Whether a name has to be typed before confirming: an open poll that shows
   * its respondents, and nothing else. `open_poll_confirm_options` applies
   * exactly this rule, and discards a name on a poll that hides them.
   */
  needsName?: boolean
  /**
   * Whether this press could be the press that opens the poll — a poll with a
   * participant list, still waiting on somebody. It is the one thing about the
   * button that is not obvious from the button, and somebody deciding whether
   * to press it should know it before they do.
   *
   * **How many have confirmed is deliberately not here.** That is the count
   * badge's job, in the poll's header, on every screen the poll appears on. It
   * is false once everybody has confirmed, which is a poll that stayed put for
   * a reason this card cannot name — a question of the group nobody has
   * finished, or a list still short of two options — so it says the creator
   * ends the stage rather than promising an opening that has already not
   * happened.
   */
  opensWhenEveryoneHas?: boolean
}

/**
 * The option-collecting stage as one person sees it, laid out as the ballot
 * that replaces it: name at the top, the poll's other questions under it, the
 * thing being filled in, and what happens next beside the button that ends
 * your part in it.
 *
 * That is the whole of why this looks the way it does. Collecting options is
 * the ballot's stage, at the same address, in the same place on the page, and
 * a reader who has done one should recognise the other — so the two cards are
 * built the same way round rather than each in whatever order it grew in.
 *
 * It stands in for the ballot on two occasions, and they are not the same
 * occasion:
 *
 *  - a poll **still collecting** its options, which has no ballot yet.
 *    Everyone in the poll sees this list and this box, the creator included,
 *    who suggests through the same RPC as everybody else rather than a path
 *    of their own. That is the same shape as the creator voting in their own
 *    open poll through the anon RPC: one code path, one set of rules, and no
 *    way for the creator's list to be built under rules nobody else's is.
 *  - a poll whose creator is **correcting** a list that is already a ballot,
 *    which only they see, and only while nobody has voted. That path is
 *    `source.kind === 'creator'`; see `OptionsSource` above. It confirms
 *    nothing and carries its own way out, as `footer`.
 *
 * Suggestions carry no name. Who suggested what would be a third disclosure
 * question on top of "who responded" and "how they voted", and the poll's
 * tags answer neither of those about the option list. The name field at the
 * top is the confirmation's, on the one poll that has no account to read one
 * from — the same field, in the same place, that the same poll's ballot asks
 * for.
 *
 * Pruning the list is creator-only either way, and sits here beside the list
 * it acts on, the same place the invite controls sit inside `Respondents`.
 * Opening the poll does not: it is what the creator does to the *poll*, so it
 * is in `CreatorControls` with the rest of the lifecycle, and this component
 * has nothing to say about when the stage ends.
 */
export function CollectOptions({
  source,
  options,
  isCreator,
  questionStrip,
  footer,
  confirm,
  onChanged,
  onConfirmed,
}: {
  source: OptionsSource
  options: PollOption[]
  isCreator: boolean
  /** Navigation for a multi-question poll, rendered inside the card as on the ballot. */
  questionStrip?: ReactNode
  /**
   * What goes in the footer row when there is nothing to confirm: the way out
   * of the creator's correction. Passed in because it belongs to the page's
   * situation rather than to the list.
   */
  footer?: ReactNode
  /** How this reader says they are done adding; see `Confirmation`. */
  confirm?: Confirmation
  /** An option arrived or left, or a confirmation moved: re-read the poll. */
  onChanged: () => void
  /**
   * A *first* confirmation went in, as against one taken back. Offered so a
   * poll of several questions can move on to the next list this reader still
   * owes, which is the whole of what they do next — exactly as a first ballot
   * moves them on. It **replaces** `onChanged` on that path: the page that
   * takes this is leaving the question, and a re-read of the question being
   * left would land after the next one had loaded.
   */
  onConfirmed?: () => void
}) {
  // Offered rather than imposed, exactly as on the ballot: the name this
  // browser last voted or confirmed under, editable like any other. See
  // lib/voterName.ts for why the browser is the one place entitled to carry
  // it from one question to the next.
  const [name, setName] = useState(rememberedVoterName)
  const [busy, setBusy] = useState(false)
  // Wrong with the name being typed, marked on the box it was typed in;
  // `error` is a request that failed, which is about the poll rather than
  // about the field.
  const [nameError, setNameError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  const needsName = confirm?.needsName === true

  async function confirmOptions() {
    if (busy || !confirm) return
    setError(null)
    setNameError(null)

    const trimmed = name.trim()
    if (needsName && !trimmed) {
      setNameError('Enter your name so the group can see who has confirmed.')
      nameRef.current?.focus()
      return
    }

    setBusy(true)
    const { error: rpcError } = await sendConfirmation(source, needsName ? trimmed : null)
    setBusy(false)

    if (rpcError) {
      setError(rpcError.message)
      return
    }
    // Remembered only once a confirmation has actually gone in under it, so a
    // name the server refused is not offered back on the next poll.
    if (needsName) rememberVoterName(trimmed)
    notifications.show({ message: 'Options confirmed', color: 'green' })
    ;(onConfirmed ?? onChanged)()
  }

  async function reopenList() {
    if (busy) return
    setError(null)
    setBusy(true)
    const { error: rpcError } = await withdrawConfirmation(source)
    setBusy(false)

    if (rpcError) {
      setError(rpcError.message)
      return
    }
    // No notification: the card in front of them becoming the list again is
    // the whole of what happened, and says so better than a message would.
    onChanged()
  }

  // Done adding, and back to the list whenever they are not. The same pair as
  // the ballot's "your vote is in" and the *Edit vote* behind it, and the same
  // window: a confirmation can be taken back for exactly as long as it can be
  // given, which is for as long as the poll is still collecting. The database
  // draws that line in `assert_collecting_options`; this card is only ever
  // rendered inside it.
  if (confirm?.confirmed) {
    return (
      <Card withBorder>
        <Stack gap="sm">
          {questionStrip}
          <Text fw={500}>You’re done adding options</Text>
          <Group justify="space-between" wrap="wrap" gap="sm">
            <OpeningNote
              isCreator={isCreator}
              whenEveryoneHas={confirm.opensWhenEveryoneHas}
              canAdd
            />
            <Button variant="light" onClick={reopenList} loading={busy}>
              Edit options
            </Button>
          </Group>
          {error && (
            <Text c="red" size="sm">
              {error}
            </Text>
          )}
        </Stack>
      </Card>
    )
  }

  return (
    <Card withBorder>
      <Stack gap="sm">
        {needsName && (
          <TextInput
            ref={nameRef}
            label="Your name"
            placeholder="Your name"
            value={name}
            onChange={(e) => {
              setName(e.currentTarget.value)
              setNameError(null)
            }}
            error={nameError}
            maxLength={VOTER_NAME_MAX}
            required
            /* Label the key "Done" rather than a Go/newline the field has no use
               for, and honour that label by putting the keyboard away. The
               ballot's name field does exactly this, and for the same reason:
               the field stands alone rather than in a form, so Enter has
               nothing to submit and would only leave the keyboard up. */
            enterKeyHint="done"
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              e.preventDefault()
              nameRef.current?.blur()
            }}
          />
        )}

        {needsName && <Divider />}
        {questionStrip}

        <OptionList source={source} options={options} isCreator={isCreator} onChanged={onChanged} />

        {error && (
          <Text c="red" size="sm">
            {error}
          </Text>
        )}

        {/* The line is what stops *Add* and *Confirm options* reading as one
            row of buttons: they are the two things this card is for, and one
            adds to a list while the other says you are finished with it. The
            ballot rules its footer off the same way, off the last option's
            divider. */}
        {confirm && <Divider />}

        {confirm ? (
          <Group justify="space-between" wrap="wrap" gap="sm" align="flex-end">
            <ConfirmNote opensWhenEveryoneHas={confirm.opensWhenEveryoneHas} />
            <Button onClick={confirmOptions} loading={busy}>
              Confirm options
            </Button>
          </Group>
        ) : (
          footer
        )}
      </Stack>
    </Card>
  )
}

/** Saying you are done, by whichever of the two identities the poll has. */
function sendConfirmation(source: OptionsSource, voterName: string | null) {
  return source.kind === 'poll'
    ? supabase.rpc('confirm_options', { p_poll_id: source.pollId })
    : openPollRpc('open_poll_confirm_options', {
        p_poll_id: source.pollId,
        p_voter_key: voterKeyFor(source.pollId),
        p_voter_name: voterName,
      })
}

/** And taking it back, which the same two functions allow on the same terms. */
function withdrawConfirmation(source: OptionsSource) {
  return source.kind === 'poll'
    ? supabase.rpc('unconfirm_options', { p_poll_id: source.pollId })
    : openPollRpc('open_poll_unconfirm_options', {
        p_poll_id: source.pollId,
        p_voter_key: voterKeyFor(source.pollId),
      })
}

/**
 * The list itself, and the box that adds to it.
 *
 * Split from the card around it because they answer to different people: this
 * is the poll's list, which everybody in the poll writes, and the card is one
 * reader's part in it. Keeping the two apart is also what keeps a suggestion
 * being typed clear of the name a confirmation is given under — two fields,
 * two states, two things that can be wrong, and no way for one to clear the
 * other's message.
 */
function OptionList({
  source,
  options,
  isCreator,
  onChanged,
}: {
  source: OptionsSource
  options: PollOption[]
  isCreator: boolean
  onChanged: () => void
}) {
  const [name, setName] = useState('')
  // Always on screen here, unlike the create form, where a `+` opens one per
  // row. That form shows a dozen option rows at once and a description field
  // under every one of them would bury the list; this box is one option at a
  // time, so the field costs two rows of a card that has nothing else in it —
  // and the alternative was a `+` that had to be found and pressed before the
  // most useful thing a suggestion can carry could be typed. So there is
  // nothing to open, and no state for whether it is open: the string is the
  // whole of it, and empty means no description, the same as it always did.
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  // What is wrong with the suggestion being typed, against the field it is
  // wrong in rather than as a line of red under the whole card, which is
  // where the request that failed still reports itself.
  const [nameError, setNameError] = useState<string | null>(null)
  const [descriptionError, setDescriptionError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const full = options.length >= MAX_OPTIONS
  // A list that is already a ballot cannot be pruned below what an election
  // needs; a list still being collected can, because `finalize_options`
  // applies the floor when it becomes a ballot. The trigger enforces both,
  // and this only decides whether to offer the button. See
  // 0028_creator_edits_options.sql.
  const atFloor = source.kind === 'creator' && options.length <= 2

  async function addOption() {
    if (busy) return

    const trimmed = name.trim()
    const trimmedDescription = description.trim()

    // The same four rules add_suggested_option applies, checked here so the
    // one that fails is marked on the field it failed in. The database is
    // still what decides, these cannot be trusted and are not relied on,
    // and anything it refuses for a reason not listed here still comes back
    // as the error under the card.
    setNameError(null)
    setDescriptionError(null)
    setError(null)

    if (!trimmed) {
      setNameError('Give the option a name.')
      return
    }
    if (trimmed.length > OPTION_NAME_MAX) {
      setNameError(tooLong('An option name', trimmed.length, OPTION_NAME_MAX))
      return
    }
    // Case-insensitive, like the database: two options differing only in
    // case are one option to everybody scoring the ballot.
    if (options.some((o) => o.name.toLowerCase() === trimmed.toLowerCase())) {
      setNameError(`“${trimmed}” is already on the list.`)
      return
    }
    if (trimmedDescription.length > OPTION_DESCRIPTION_MAX) {
      setDescriptionError(
        tooLong('A description', trimmedDescription.length, OPTION_DESCRIPTION_MAX),
      )
      return
    }
    if (full) {
      setNameError(`This poll already holds the ${MAX_OPTIONS} options a ballot can.`)
      return
    }

    setBusy(true)
    const body = { p_name: trimmed, p_description: trimmedDescription || null }
    const { error: rpcError } =
      source.kind === 'poll'
        ? await supabase.rpc('suggest_option', { p_poll_id: source.pollId, ...body })
        : source.kind === 'creator'
          ? await supabase.rpc('creator_add_option', { p_poll_id: source.pollId, ...body })
          : await supabase.rpc('open_poll_suggest_option', { p_poll_id: source.pollId, ...body })
    setBusy(false)

    if (rpcError) {
      setError(rpcError.message)
      return
    }
    setName('')
    setDescription('')
    notifications.show({ message: `Added “${trimmed}”`, color: 'green' })
    onChanged()
  }

  // The creator prunes the list directly, the same way they manage the invite
  // list: the row is theirs to delete under the poll's own policies, and
  // nothing about a poll with no votes in it needs a function to say so.
  async function removeOption(option: PollOption) {
    if (busy) return

    setError(null)
    setBusy(true)
    const { error: deleteError } = await supabase.from('candidates').delete().eq('id', option.id)
    setBusy(false)

    if (deleteError) {
      setError(deleteError.message)
      return
    }
    onChanged()
  }

  return (
    <Stack gap="sm">
      {options.length === 0 ? (
        <Text size="sm" c="dimmed">
          Nothing suggested yet. Add the first one.
        </Text>
      ) : (
        options.map((option) => (
          <Fragment key={option.id}>
            <Group justify="space-between" wrap="nowrap" gap="sm">
              <div style={{ minWidth: 0 }}>
                <Text fw={500}>{option.name}</Text>
                {option.description && <OptionDescription description={option.description} />}
              </div>
              {isCreator && (
                <Tooltip label="A poll needs at least two options" disabled={!atFloor} withArrow>
                  {/* The span is what a tooltip on a disabled button needs:
                      a disabled control fires no pointer events of its
                      own, so the reason it is disabled would never be
                      readable without something around it that does. */}
                  <span>
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      disabled={atFloor}
                      aria-label={`Remove ${option.name}`}
                      onClick={() => removeOption(option)}
                    >
                      &times;
                    </ActionIcon>
                  </span>
                </Tooltip>
              )}
            </Group>
            <Divider />
          </Fragment>
        ))
      )}

      <Group gap="xs" align="flex-start" wrap="nowrap">
        <Stack gap={4} style={{ flex: 1 }}>
          <TextInput
            value={name}
            onChange={(e) => {
              setName(e.currentTarget.value)
              // The message was about what was in the box; it stops being
              // true the moment that changes.
              setNameError(null)
            }}
            placeholder="Add an option"
            error={nameError}
            /* The field stands alone rather than in a form, so Enter has
               nothing to submit unless it is given something. */
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              e.preventDefault()
              addOption()
            }}
          />
          {/* No autoFocus: the field is here on arrival rather than
              opened, so taking the cursor off the name field would be
              taking it off the one thing every option needs. */}
          <DescriptionField
            value={description}
            onChange={(e) => {
              setDescription(e.currentTarget.value)
              setDescriptionError(null)
            }}
            placeholder="Description (optional)"
            error={descriptionError}
          />
        </Stack>
        <Button variant="light" onClick={addOption} disabled={full}>
          Add
        </Button>
      </Group>

      {full && (
        <Text size="xs" c="dimmed">
          A ballot may only have {MAX_OPTIONS} options.
        </Text>
      )}

      {error && (
        <Text c="red" size="sm">
          {error}
        </Text>
      )}
    </Stack>
  )
}

/**
 * Who is done adding options, on an open poll that names its respondents.
 *
 * The invite side has no card of its own: its roster *is* the invite list, so
 * `Respondents` says it there, on the card it already draws, with the badge
 * answering "confirmed?" instead of "voted?" while the poll is still
 * collecting. Behind a share link there is no list to annotate — the names
 * exist only because people typed them — so there is a card.
 *
 * No embargo, unlike the voter roster it sits in place of. What that embargo
 * protects is the order ballots arrived in; a poll still collecting its
 * options has no ballots to attach an order to, and knowing who has finished
 * is the entire point of the thing.
 */
export function Confirmations({ names }: { names: string[] }) {
  return (
    <NameRoster
      title="Confirmed the options"
      names={names}
      empty="Nobody has confirmed the options yet."
    />
  )
}
