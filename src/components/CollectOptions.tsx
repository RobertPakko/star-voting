import { useState } from 'react'
import {
  ActionIcon,
  Button,
  Card,
  Group,
  Modal,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core'
import { useDisclosure } from '@mantine/hooks'
import { notifications } from '@mantine/notifications'
import { supabase } from '../lib/supabase'
import { MAX_OPTIONS, OPTION_DESCRIPTION_MAX, OPTION_NAME_MAX, tooLong } from '../lib/limits'
import { DescriptionField } from './DescriptionField'
import { OptionDescription } from './OptionDescription'
import type { PollOption } from '../lib/types'

/**
 * Which suggestion endpoint to write to. Same split as ResultsSource and
 * BallotsSource, and for the same reason: a session proves the caller belongs
 * to an invite poll, the share token proves it for an open one.
 */
export type OptionsSource = { kind: 'poll'; pollId: string } | { kind: 'token'; token: string }

/**
 * A poll that is still collecting its options, in place of the ballot it does
 * not have yet.
 *
 * Everyone in the poll sees the same list and the same box to add to it;
 * the creator included, who suggests through the same RPC as everybody else
 * rather than a path of their own. That is the same shape as the creator
 * voting in their own open poll through the anon RPC: one code path, one set
 * of rules, and no way for the creator's list to be built by rules nobody
 * else's is.
 *
 * Suggestions carry no name. Who suggested what would be a third disclosure
 * question on top of "who responded" and "how they voted", and the poll's
 * tags answer neither of those about the option list.
 *
 * Two things are creator-only, and both are about ending the stage rather
 * than taking part in it: pruning the list, and finalizing it. They sit here,
 * beside the list they act on, rather than in `CreatorControls`; the same
 * place the invite controls sit inside `Respondents`, and for the same
 * reason. `CreatorControls` holds what the creator does to the *poll*.
 */
export function CollectOptions({
  source,
  pollId,
  options,
  isCreator,
  onChanged,
}: {
  source: OptionsSource
  /** Finalizing is authenticated and by id, whichever way suggestions go in. */
  pollId: string
  options: PollOption[]
  isCreator: boolean
  /** An option arrived or left, or the list was finalized: re-read the poll. */
  onChanged: () => void
}) {
  const [name, setName] = useState('')
  // null is "no description field on screen", exactly as in the create form:
  // showing one means giving it an empty string to type into, and hiding one
  // throws away what was in it.
  const [description, setDescription] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // What is wrong with the suggestion being typed, against the field it is
  // wrong in rather than as a line of red under the whole card, which is
  // where the request that failed still reports itself.
  const [nameError, setNameError] = useState<string | null>(null)
  const [descriptionError, setDescriptionError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [finalizeOpened, finalizeModal] = useDisclosure(false)

  const enough = options.length >= 2
  const full = options.length >= MAX_OPTIONS

  async function addOption() {
    const trimmed = name.trim()
    const trimmedDescription = description?.trim() ?? ''

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
      setNameError(`“${trimmed}” has already been suggested.`)
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
        : await supabase.rpc('open_poll_suggest_option', { p_token: source.token, ...body })
    setBusy(false)

    if (rpcError) {
      setError(rpcError.message)
      return
    }
    setName('')
    setDescription(null)
    notifications.show({ message: `Added “${trimmed}”`, color: 'green' })
    onChanged()
  }

  // The creator prunes the list directly, the same way they manage the invite
  // list: the row is theirs to delete under the poll's own policies, and
  // nothing about a poll with no votes in it needs a function to say so.
  async function removeOption(option: PollOption) {
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

  async function finalize() {
    setError(null)
    setBusy(true)
    const { error: rpcError } = await supabase.rpc('finalize_options', { p_poll_id: pollId })
    setBusy(false)
    finalizeModal.close()

    if (rpcError) {
      setError(rpcError.message)
      return
    }
    notifications.show({ message: 'Voting is open', color: 'green' })
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
                  <ActionIcon
                    variant="subtle"
                    color="red"
                    aria-label={`Remove ${option.name}`}
                    onClick={() => removeOption(option)}
                  >
                    &times;
                  </ActionIcon>
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
            {description !== null && (
              <DescriptionField
                value={description}
                onChange={(e) => {
                  setDescription(e.currentTarget.value)
                  setDescriptionError(null)
                }}
                placeholder="What it is, a caveat, a link"
                error={descriptionError}
                autoFocus
              />
            )}
          </Stack>
          <Tooltip
            label={description === null ? 'Add description' : 'Remove description'}
            withArrow
          >
            <ActionIcon
              variant="subtle"
              color="gray"
              onClick={() => setDescription((d) => (d === null ? '' : null))}
              aria-label={
                description === null
                  ? 'Add a description to this option'
                  : 'Remove this option’s description'
              }
            >
              {description === null ? '+' : '−'}
            </ActionIcon>
          </Tooltip>
          <Button variant="light" onClick={addOption} loading={busy} disabled={full}>
            Add
          </Button>
        </Group>

        {error && (
          <Text c="red" size="sm">
            {error}
          </Text>
        )}

        {isCreator ? (
          <Group justify="space-between" wrap="wrap" gap="sm">
            <Text size="sm" c="dimmed" style={{ flex: 1, minWidth: 200 }}>
              Nobody can vote while the list is still growing. Open the poll once the options are
              settled — after that the list is fixed, like any other poll’s.
            </Text>
            <Button color="orange" variant="light" disabled={!enough} onClick={finalizeModal.open}>
              Open for voting
            </Button>
          </Group>
        ) : (
          <Text size="sm" c="dimmed">
            Voting hasn’t started. Everyone can add options until the poll’s creator opens the poll.
          </Text>
        )}

        {full && (
          <Text size="xs" c="dimmed">
            This poll holds the {MAX_OPTIONS} options a ballot can. A list nobody reads to the end
            is not one anybody can score honestly.
          </Text>
        )}
      </Stack>

      <Modal
        opened={finalizeOpened}
        onClose={finalizeModal.close}
        title="Open this poll for voting?"
        centered
      >
        <Stack gap="md">
          <Text size="sm">
            The {options.length} current options become the ballot and voting opens.
          </Text>
          <Text size="sm" c="dimmed">
            Options cannot be added or removed once voting starts.
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={finalizeModal.close}>
              Cancel
            </Button>
            <Button color="orange" onClick={finalize} loading={busy}>
              Open for voting
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Card>
  )
}
