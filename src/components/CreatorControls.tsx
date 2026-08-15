import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Group,
  Modal,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core'
import { useDisclosure } from '@mantine/hooks'
import { notifications } from '@mantine/notifications'
import { supabase } from '../lib/supabase'
import type { Invitee, PollStatus } from '../lib/types'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Creator-only controls: manage the invitee list, close voting early, and
 * delete the poll. Closing exists so a single person who never votes can't
 * freeze the results permanently.
 */
export function CreatorControls({
  pollId,
  status,
  onChange,
}: {
  pollId: string
  status: PollStatus
  onChange: () => void
}) {
  const navigate = useNavigate()
  const [invitees, setInvitees] = useState<Invitee[] | null>(null)
  const [newEmail, setNewEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deleteOpened, deleteModal] = useDisclosure(false)
  const [closeOpened, closeModal] = useDisclosure(false)

  const loadInvitees = useCallback(async () => {
    const { data, error: rpcError } = await supabase.rpc('poll_invitees', { p_poll_id: pollId })
    if (!rpcError) setInvitees((data as Invitee[]) ?? [])
  }, [pollId])

  useEffect(() => {
    loadInvitees()
  }, [loadInvitees])

  async function addInvitee() {
    const email = newEmail.trim().toLowerCase()
    setError(null)
    if (!EMAIL_RE.test(email)) {
      setError('Enter a valid email address.')
      return
    }
    if (invitees?.some((i) => i.email === email)) {
      setError('That person is already invited.')
      return
    }

    setBusy(true)
    const { error: insertError } = await supabase.from('invited_voters').insert({ poll_id: pollId, email })
    setBusy(false)

    if (insertError) {
      setError(insertError.message)
      return
    }
    setNewEmail('')
    notifications.show({ message: `Invited ${email}`, color: 'green' })
    await loadInvitees()
    onChange()
  }

  async function removeInvitee(email: string) {
    setError(null)
    setBusy(true)
    const { error: deleteError } = await supabase
      .from('invited_voters')
      .delete()
      .eq('poll_id', pollId)
      .eq('email', email)
    setBusy(false)

    if (deleteError) {
      setError(deleteError.message)
      return
    }
    notifications.show({ message: `Removed ${email}`, color: 'green' })
    await loadInvitees()
    onChange()
  }

  async function closePoll() {
    setError(null)
    setBusy(true)
    const { error: rpcError } = await supabase.rpc('close_poll', { p_poll_id: pollId })
    setBusy(false)
    closeModal.close()

    if (rpcError) {
      setError(rpcError.message)
      return
    }
    notifications.show({ message: 'Voting closed', color: 'green' })
    onChange()
  }

  async function deletePoll() {
    setBusy(true)
    const { error: deleteError } = await supabase.from('polls').delete().eq('id', pollId)
    setBusy(false)
    deleteModal.close()

    if (deleteError) {
      setError(deleteError.message)
      return
    }
    notifications.show({ message: 'Poll deleted', color: 'green' })
    navigate('/')
  }

  const pending = invitees?.filter((i) => !i.has_voted).length ?? 0
  const canClose = !status.is_closed && !status.is_complete && status.voted_count > 0

  return (
    <Card withBorder mt="xl">
      <Stack gap="md">
        <Title order={4}>Manage poll</Title>

        <Stack gap="xs">
          <Text size="sm" fw={500}>
            Invited voters
          </Text>
          {invitees?.map((invitee) => (
            <Group key={invitee.email} justify="space-between" wrap="nowrap" gap="xs">
              <Text size="sm" truncate style={{ flex: 1, minWidth: 0 }}>
                {invitee.email}
              </Text>
              <Group gap="xs" wrap="nowrap">
                <Badge size="sm" variant="light" color={invitee.has_voted ? 'green' : 'orange'}>
                  {invitee.has_voted ? 'Voted' : 'Pending'}
                </Badge>
                <ActionIcon
                  variant="subtle"
                  color="red"
                  aria-label={`Remove ${invitee.email}`}
                  // Someone who already voted can't be removed -- their ballot
                  // is counted and can't be honestly un-counted.
                  disabled={invitee.has_voted || status.is_closed || busy}
                  onClick={() => removeInvitee(invitee.email)}
                >
                  &times;
                </ActionIcon>
              </Group>
            </Group>
          ))}

          {!status.is_closed && (
            <Group gap="xs" wrap="nowrap">
              <TextInput
                placeholder="Invite another voter"
                value={newEmail}
                onChange={(e) => setNewEmail(e.currentTarget.value)}
                onKeyDown={(e) => e.key === 'Enter' && addInvitee()}
                style={{ flex: 1 }}
              />
              <Button variant="light" onClick={addInvitee} loading={busy}>
                Add
              </Button>
            </Group>
          )}
        </Stack>

        {error && (
          <Text c="red" size="sm">
            {error}
          </Text>
        )}

        <Group justify="space-between" mt="xs">
          {canClose ? (
            <Button variant="light" color="orange" onClick={closeModal.open}>
              Close voting now
            </Button>
          ) : (
            <span />
          )}
          <Button variant="subtle" color="red" onClick={deleteModal.open}>
            Delete poll
          </Button>
        </Group>
      </Stack>

      <Modal opened={closeOpened} onClose={closeModal.close} title="Close voting now?" centered>
        <Stack gap="md">
          <Text size="sm">
            Results will be revealed using the {status.voted_count} vote
            {status.voted_count === 1 ? '' : 's'} cast so far.
            {pending > 0 && ` ${pending} invited ${pending === 1 ? 'person' : 'people'} won't get to vote.`}
          </Text>
          <Text size="sm" c="dimmed">
            This can't be undone — a poll can't be reopened once closed.
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={closeModal.close}>
              Cancel
            </Button>
            <Button color="orange" onClick={closePoll} loading={busy}>
              Close voting
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal opened={deleteOpened} onClose={deleteModal.close} title="Delete this poll?" centered>
        <Stack gap="md">
          <Text size="sm">
            The poll, its options, and every vote cast will be permanently deleted. This can't be
            undone.
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={deleteModal.close}>
              Cancel
            </Button>
            <Button color="red" onClick={deletePoll} loading={busy}>
              Delete poll
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Card>
  )
}
