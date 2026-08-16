import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Card, Group, Modal, Stack, Text, Title } from '@mantine/core'
import { useDisclosure } from '@mantine/hooks'
import { notifications } from '@mantine/notifications'
import { supabase } from '../lib/supabase'
import type { PollStatus } from '../lib/types'

/**
 * Creator-only lifecycle controls: close voting early, and delete the poll.
 * The invitee list lives in <Respondents> now, because on a poll that shows
 * respondents it isn't creator-only any more.
 *
 * Closing exists so a single person who never votes can't freeze the
 * results permanently -- and for open polls it's the only way results are
 * ever revealed, since there is no roster to complete.
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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deleteOpened, deleteModal] = useDisclosure(false)
  const [closeOpened, closeModal] = useDisclosure(false)

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

  const canClose = !status.is_closed && !status.is_complete && status.voted_count > 0
  // Open polls have no invite list, so invited_count is 0 and there is
  // nobody we can say we're cutting off.
  const pending = Math.max(0, status.invited_count - status.voted_count)

  return (
    <Card withBorder mt="xl">
      <Stack gap="md">
        <Title order={4}>Manage poll</Title>

        {error && (
          <Text c="red" size="sm">
            {error}
          </Text>
        )}

        <Group justify="space-between">
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
            {pending > 0 &&
              ` ${pending} invited ${pending === 1 ? 'person' : 'people'} won't get to vote.`}
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
