import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Card, Group, Modal, Stack, Text, Title, Tooltip } from '@mantine/core'
import { useDisclosure } from '@mantine/hooks'
import { notifications } from '@mantine/notifications'
import { supabase } from '../lib/supabase'
import { forgetPoll } from '../lib/settled'
import { ShareLink } from './ShareLink'
import type { Poll, PollStatus } from '../lib/types'

/**
 * Creator-only lifecycle controls: everything the creator does to the *poll*,
 * in one block. Open it for voting, close voting early, correct the options,
 * duplicate it, clear its votes, delete it.
 *
 * The invitee list is not here — it lives in <Respondents>, because on a poll
 * that shows respondents it isn't creator-only any more.
 *
 * The share link lives here rather than beside the ballot: handing the poll
 * out is something the creator does to the poll, not something a voter needs
 * while scoring options. Keeping it in this block also means it is never
 * withheld; the creator has to be able to send the link out before anyone,
 * themselves included, has voted.
 *
 * Closing exists so a single person who never votes can't freeze the
 * results permanently and for open polls it's the only way results are
 * ever revealed, since there is no roster to complete.
 *
 * Every button that changes the poll confirms in a modal first, and the modal
 * is where what it will do is spelled out. None of them carries a paragraph
 * of explanation out here beside it: the block would be unreadable, and the
 * sentence anybody actually needs is the one in front of them at the moment
 * they are deciding.
 */
export function CreatorControls({
  poll,
  status,
  optionCount,
  editingOptions,
  onEditOptions,
  onChange,
}: {
  poll: Pick<Poll, 'id' | 'title' | 'mode' | 'public_token'>
  status: PollStatus
  /** How many options the poll holds: the floor "Open poll" has to clear. */
  optionCount: number
  /**
   * Whether the page is already showing the option list to be corrected, in
   * which case this block does not offer to show it again: the list has its
   * own way out, sitting under the thing it acts on.
   */
  editingOptions: boolean
  /** Show that list; the page owns it, since it replaces the ballot. */
  onEditOptions: (editing: boolean) => void
  onChange: () => void
}) {
  const pollId = poll.id
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deleteOpened, deleteModal] = useDisclosure(false)
  const [closeOpened, closeModal] = useDisclosure(false)
  const [resetOpened, resetModal] = useDisclosure(false)
  const [openOpened, openModal] = useDisclosure(false)
  const [frozenOpened, frozenModal] = useDisclosure(false)

  async function resetPoll() {
    setError(null)
    setBusy(true)
    const { error: rpcError } = await supabase.rpc('reset_poll', { p_poll_id: pollId })
    setBusy(false)
    resetModal.close()

    if (rpcError) {
      setError(rpcError.message)
      return
    }
    // Resetting is the one thing that un-settles a settled poll, so it is
    // also the one thing that has to throw away what the browser remembered
    // about it; the tally, the ballot grid and the elected option. See
    // lib/settled.ts for what that cache does and does not promise.
    forgetPoll(pollId, poll.public_token)
    notifications.show({ message: 'Votes cleared', color: 'green' })
    onChange()
  }

  async function openPoll() {
    setError(null)
    setBusy(true)
    const { error: rpcError } = await supabase.rpc('finalize_options', { p_poll_id: pollId })
    setBusy(false)
    openModal.close()

    if (rpcError) {
      setError(rpcError.message)
      return
    }
    notifications.show({ message: 'Voting is open', color: 'green' })
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
    // Nothing left to remember it by.
    forgetPoll(pollId, poll.public_token)
    notifications.show({ message: 'Poll deleted', color: 'green' })
    navigate('/')
  }

  const canClose = !status.is_closed && !status.is_complete && status.voted_count > 0
  // Nothing to clear on a fresh poll, but a closed one is worth offering
  // even with no votes, since resetting is the only way to reopen it.
  const canReset = status.voted_count > 0 || status.is_closed
  // Ending the collecting stage, and the floor it has to clear: the same two
  // options `create_poll` demands of a poll whose creator wrote the list.
  const canOpen = status.soliciting && !status.is_closed
  const enoughToOpen = optionCount >= 2
  // Correcting a list that is already a ballot. The database allows it on the
  // creator's own poll, open, with nobody having voted -- see
  // 0028_creator_edits_options.sql -- and that is what `optionsEditable` is.
  //
  // The *button* is offered more widely than that, on purpose. It used to
  // disappear the moment the first vote landed, on a page that otherwise
  // looked exactly as it had a second earlier, so the only thing a creator
  // could learn from it was that something they had just been able to do was
  // gone. Now it stays and says why, and points at the two things that do
  // work. Closing the poll takes it away, but a poll that has closed rewrites
  // this whole block and the page under it, so nothing there vanishes
  // quietly.
  const optionsEditable = !status.is_closed && status.voted_count === 0
  const showEditOptions = !status.soliciting && !status.is_closed && !editingOptions
  // Open polls have no invite list, so invited_count is 0 and there is
  // nobody we can say we're cutting off.
  const pending = Math.max(0, status.invited_count - status.voted_count)

  return (
    <Card withBorder>
      <Stack gap="md">
        <Title order={4}>Manage poll</Title>

        <ShareLink poll={poll} />

        {error && (
          <Text c="red" size="sm">
            {error}
          </Text>
        )}

        <Group gap="sm" wrap="wrap">
          {canOpen && (
            <Tooltip label="Add at least two options first" disabled={enoughToOpen} withArrow>
              {/* A disabled button fires no pointer events of its own, so the
                  reason it is disabled needs something around it that does. */}
              <span>
                <Button
                  variant="light"
                  color="orange"
                  disabled={!enoughToOpen}
                  onClick={openModal.open}
                >
                  Open poll
                </Button>
              </span>
            </Tooltip>
          )}
          {showEditOptions && (
            <Button
              variant="light"
              onClick={() => (optionsEditable ? onEditOptions(true) : frozenModal.open())}
            >
              Edit options
            </Button>
          )}
          {canClose && (
            <Button variant="light" color="orange" onClick={closeModal.open}>
              Close voting
            </Button>
          )}
          {/* Opens the create form prefilled from this poll, so the copy can
              be edited before it exists. */}
          <Button variant="light" onClick={() => navigate(`/polls/new?from=${pollId}`)}>
            Duplicate
          </Button>
          {canReset && (
            <Button variant="light" color="orange" onClick={resetModal.open}>
              Reset votes
            </Button>
          )}
          <Button variant="subtle" color="red" onClick={deleteModal.open} ml="auto">
            Delete poll
          </Button>
        </Group>
      </Stack>

      {/* Why the option list is closed, and the two ways there are round it.
          Both are offered as buttons rather than described and left to be
          found: they are in this same block, and a modal that says "use
          Reset votes" while covering the Reset votes button is a riddle. */}
      <Modal
        opened={frozenOpened}
        onClose={frozenModal.close}
        title="The options are settled"
        centered
      >
        <Stack gap="md">
          <Text size="sm">
            This poll has {status.voted_count} vote{status.voted_count === 1 ? '' : 's'} in it, so
            its options can't change. Everyone who voted scored the list as it stands, and adding or
            removing an option now would leave their ballots answering a different question from
            everybody else's.
          </Text>
          <Text size="sm" c="dimmed">
            Two ways round it. <b>Clear the votes</b> to reopen the list on this same poll, keeping
            its link — everyone who voted is free to vote again. Or <b>duplicate</b> the poll to
            start a fresh one with the options you want, leaving this one as it is; the copy gets
            its own link.
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={frozenModal.close}>
              Cancel
            </Button>
            <Button variant="light" onClick={() => navigate(`/polls/new?from=${pollId}`)}>
              Duplicate
            </Button>
            <Button
              color="orange"
              onClick={() => {
                frozenModal.close()
                resetModal.open()
              }}
            >
              Clear votes
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal
        opened={openOpened}
        onClose={openModal.close}
        title="Open this poll for voting?"
        centered
      >
        <Stack gap="md">
          <Text size="sm">
            The {optionCount} current options become the ballot and voting opens.
          </Text>
          <Text size="sm" c="dimmed">
            Nobody can suggest an option after this. You can still correct the list yourself, up
            until the first vote comes in.
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={openModal.close}>
              Cancel
            </Button>
            <Button color="orange" onClick={openPoll} loading={busy}>
              Open poll
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal opened={closeOpened} onClose={closeModal.close} title="Close voting?" centered>
        <Stack gap="md">
          <Text size="sm">
            Results will be revealed using the current {status.voted_count} vote
            {status.voted_count === 1 ? '' : 's'}.
            {pending > 0 &&
              ` ${pending} invited ${pending === 1 ? 'person' : 'people'} won't get to vote.`}
          </Text>
          <Text size="sm" c="dimmed">
            The only way to reopen the poll is to reset the votes.
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

      <Modal opened={resetOpened} onClose={resetModal.close} title="Clear every vote?" centered>
        <Stack gap="md">
          <Text size="sm">
            {status.voted_count === 0
              ? 'This poll has no votes to clear.'
              : `The ${status.voted_count} current vote${status.voted_count === 1 ? '' : 's'} will be deleted, along with any results.`}
          </Text>
          <Text size="sm">
            The poll keeps its options{status.invited_count > 0 && ', its invitee list'} and its
            link
            {status.is_closed && ', and reopens for voting'}. Everyone who already voted will be
            able to vote again.
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={resetModal.close}>
              Cancel
            </Button>
            <Button color="orange" onClick={resetPoll} loading={busy}>
              Clear votes
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
