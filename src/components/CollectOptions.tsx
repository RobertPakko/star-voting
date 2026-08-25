import { useState } from 'react'
import type { ReactNode } from 'react'
import { ActionIcon, Button, Card, Group, Stack, Text, TextInput, Tooltip } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { supabase } from '../lib/supabase'
import { MAX_OPTIONS, OPTION_DESCRIPTION_MAX, OPTION_NAME_MAX, tooLong } from '../lib/limits'
import { DescriptionField } from './DescriptionField'
import { OptionDescription } from './OptionDescription'
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
 */
export type OptionsSource =
  | { kind: 'poll'; pollId: string }
  | { kind: 'open'; pollId: string }
  | { kind: 'creator'; pollId: string }

/**
 * A poll's option list, and the box that adds to it.
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
 *    `source.kind === 'creator'`; see `OptionsSource` above.
 *
 * Suggestions carry no name. Who suggested what would be a third disclosure
 * question on top of "who responded" and "how they voted", and the poll's
 * tags answer neither of those about the option list.
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
  footer,
  onChanged,
}: {
  source: OptionsSource
  options: PollOption[]
  isCreator: boolean
  /**
   * What goes under the box: who may still add to this list and until when,
   * or the way out of the creator's correction. Passed in because the answer
   * belongs to the page's situation rather than to the list.
   */
  footer?: ReactNode
  /** An option arrived or left: re-read the poll. */
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
    <Card withBorder>
      <Stack gap="md">
        {options.length === 0 ? (
          <Text size="sm" c="dimmed">
            Nothing suggested yet. Add the first one.
          </Text>
        ) : (
          <Stack gap="xs">
            {options.map((option) => (
              <Group key={option.id} justify="space-between" wrap="nowrap" gap="sm">
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
            ))}
          </Stack>
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

        {error && (
          <Text c="red" size="sm">
            {error}
          </Text>
        )}

        {footer}

        {full && (
          <Text size="xs" c="dimmed">
            A ballot may only have {MAX_OPTIONS} options.
          </Text>
        )}
      </Stack>
    </Card>
  )
}
