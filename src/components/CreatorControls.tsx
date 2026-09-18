import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Card, Group, Modal, Stack, Text, Title, Tooltip } from '@mantine/core'
import { useDisclosure } from '@mantine/hooks'
import { notifications } from '@mantine/notifications'
import { supabase } from '../lib/supabase'
import { ShareLink } from './ShareLink'
import type { GroupQuestion, Poll, PollStatus } from '../lib/types'
import { shortPollId } from '../lib/pollId'

/**
 * Creator-only lifecycle controls: everything the creator does to the *poll*,
 * in one block. Open it for voting, close voting early, open it again,
 * correct the options, duplicate it, delete it.
 *
 * Two of those used to be refusals. The option list froze on the first ballot
 * and a closed poll stayed closed, and both of them sent the creator to
 * Duplicate — which is a different poll on a different link, and everyone who
 * had the old one has to be told. They are allowed now, and what stands in
 * for the refusal is a modal that says what the act will leave behind: the
 * results carry a banner saying the options moved under the votes, or that
 * votes moved after the results were out. See the flags on `polls`.
 *
 * **Reset is gone.** It cleared every vote to buy back an option list or an
 * unclosed poll, and both of those are now had without paying for them.
 * Duplicate is the honest version of what was left: a genuinely fresh poll,
 * rather than one whose voters are quietly asked to vote a second time.
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
  questions = [],
  editingOptions,
  onEditOptions,
  onChange,
}: {
  poll: Pick<Poll, 'id' | 'title' | 'mode' | 'closed_at' | 'group_id'>
  status: PollStatus
  /** How many options the poll holds: the floor "Open poll" has to clear. */
  optionCount: number
  /**
   * The poll's other questions, when it asks several. Opening acts on all of
   * them at once, so the floor this button has to clear is every question's
   * and not just this one's; empty on a poll that asks one question, where
   * `optionCount` is the whole story.
   */
  questions?: GroupQuestion[]
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
  const [reopenOpened, reopenModal] = useDisclosure(false)
  const [openOpened, openModal] = useDisclosure(false)
  const [lateEditOpened, lateEditModal] = useDisclosure(false)

  async function reopenPoll() {
    setError(null)
    setBusy(true)
    const { error: rpcError } = await supabase.rpc('reopen_poll', { p_poll_id: pollId })
    setBusy(false)
    reopenModal.close()

    if (rpcError) {
      setError(rpcError.message)
      return
    }
    notifications.show({ message: 'Voting is open again', color: 'green' })
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
    // The whole poll, not the question in front of the creator. Close and
    // reopen already act on the group -- they go through functions that walk
    // it -- and deleting one question of a poll would leave the rest of it
    // standing with a gap in the middle. The row-level security is the same
    // either way: it allows the creator to delete polls they created, and
    // they created every question in the group.
    const query = supabase.from('polls').delete()
    const { error: deleteError } = await (poll.group_id
      ? query.eq('group_id', poll.group_id)
      : query.eq('id', pollId))
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
  // The way back, and the only state it means anything in. An invite poll
  // everyone has voted in is revealed by its turnout rather than by its close
  // -- see poll_gate_open -- so reopening one would put the poll back to
  // taking votes it has nobody left to take, and leave its results on screen
  // throughout. The database would allow it and change nothing visible, which
  // is the worst of both; the button says no instead.
  const canReopen = status.is_closed && !status.is_complete
  // Ending the collecting stage, and the floor it has to clear: the same two
  // options `create_poll` demands of a poll whose creator wrote the list.
  const canOpen = status.soliciting && !status.is_closed
  // Opening is one act over every question, and the database refuses it until
  // all of them clear the floor. The button applies the same rule rather than
  // offering itself and being turned down -- and names the question that is
  // short, since on a poll of five "add two options" leaves the creator to
  // find which one.
  const short = questions.filter((question) => question.option_count < 2)
  const enoughToOpen = questions.length > 0 ? short.length === 0 : optionCount >= 2
  // Correcting a list that is already a ballot. The database allows it on the
  // creator's own poll for as long as the poll is open -- votes in it or not,
  // see 0063 -- so the button is offered for exactly that long and the only
  // thing that changes is what is said on the way in: with no votes cast
  // there is nothing to warn anybody about, and with votes cast there is a
  // modal spelling out what the correction will leave on the results.
  //
  // Closing the poll does take it away, and that is not the same problem: a
  // poll that has closed rewrites this whole block and the page under it, so
  // nothing there vanishes quietly.
  const lateEdit = status.voted_count > 0
  const showEditOptions = !status.soliciting && !status.is_closed && !editingOptions
  // Open polls have no invite list, so invited_count is 0 and there is
  // nobody we can say we're cutting off.
  const pending = Math.max(0, status.invited_count - status.voted_count)

  return (
    <Stack gap={2}>
      <Title order={4}>Manage poll</Title>
      <Card withBorder>
        <Stack gap="xs">
          <ShareLink poll={poll} />

          {error && (
            <Text c="red" size="sm">
              {error}
            </Text>
          )}

          <Group gap="sm" wrap="wrap">
            {canOpen && (
              <Tooltip
                label={
                  short.length
                    ? `Add at least two options to ${short.map((q) => `"${q.question_title}"`).join(', ')} first`
                    : 'Add at least two options first'
                }
                disabled={enoughToOpen}
                withArrow
                multiline
                w={260}
              >
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
            {canClose && (
              <Button variant="light" color="orange" onClick={closeModal.open}>
                Close poll
              </Button>
            )}
            {canReopen && (
              <Button variant="light" color="orange" onClick={reopenModal.open}>
                Reopen poll
              </Button>
            )}
            {showEditOptions && (
              <Button
                variant="light"
                onClick={() => (lateEdit ? lateEditModal.open() : onEditOptions(true))}
              >
                Edit options
              </Button>
            )}
            {/* Opens the create form prefilled from this poll, so the copy can
                be edited before it exists. */}
            <Button
              variant="light"
              onClick={() => navigate(`/polls/new?from=${shortPollId(pollId)}`)}
            >
              Duplicate
            </Button>
            <Button variant="subtle" color="red" onClick={deleteModal.open} ml="auto">
              Delete
            </Button>
          </Group>
        </Stack>

        <Modal
          opened={lateEditOpened}
          onClose={lateEditModal.close}
          title={<Text fw={600}>Edit options after voting has started?</Text>}
          centered
        >
          <Stack gap="md">
            <Text size="sm">
              Votes have already been cast. You can still update the options, but the results will
              carry a note saying the options were edited after votes had been cast.
            </Text>
            <Group justify="flex-end">
              <Button variant="default" onClick={lateEditModal.close}>
                Cancel
              </Button>
              <Button
                color="orange"
                onClick={() => {
                  lateEditModal.close()
                  onEditOptions(true)
                }}
              >
                Edit options
              </Button>
            </Group>
          </Stack>
        </Modal>

        <Modal
          opened={openOpened}
          onClose={openModal.close}
          title={<Text fw={600}>Open this poll for voting?</Text>}
          centered
        >
          <Stack gap="md">
            <Text size="sm">
              {questions.length > 0
                ? `Every question's options become its ballot, and voting opens on all ${questions.length} of them.`
                : `The ${optionCount} current options become the ballot and voting opens.`}
            </Text>
            <Text size="sm" c="dimmed">
              Nobody can suggest an option after this. You can still correct the{' '}
              {questions.length > 0 ? 'lists' : 'list'} yourself until the first vote comes in.
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

        <Modal
          opened={closeOpened}
          onClose={closeModal.close}
          title={<Text fw={600}>Close poll?</Text>}
          centered
        >
          <Stack gap="md">
            <Text size="sm">
              The poll will be closed and results will be revealed using the {status.voted_count}{' '}
              current vote
              {status.voted_count === 1 ? '' : 's'}.
              {pending > 0 &&
                ` ${pending} invited ${pending === 1 ? 'person' : 'people'} won't get to vote.`}
            </Text>
            <Group justify="flex-end">
              <Button variant="default" onClick={closeModal.close}>
                Cancel
              </Button>
              <Button color="orange" onClick={closePoll} loading={busy}>
                Close poll
              </Button>
            </Group>
          </Stack>
        </Modal>

        <Modal
          opened={reopenOpened}
          onClose={reopenModal.close}
          title={<Text fw={600}>Reopen this poll?</Text>}
          centered
        >
          <Stack gap="md">
            <Text size="sm">
              New votes can be cast and existing votes can be changed. If any updates are made, the
              results will carry a note saying that votes were changed after results were revealed.
            </Text>
            <Group justify="flex-end">
              <Button variant="default" onClick={reopenModal.close}>
                Cancel
              </Button>
              <Button color="orange" onClick={reopenPoll} loading={busy}>
                Reopen poll
              </Button>
            </Group>
          </Stack>
        </Modal>

        <Modal
          opened={deleteOpened}
          onClose={deleteModal.close}
          title={<Text fw={600}>Delete this poll?</Text>}
          centered
        >
          <Stack gap="md">
            <Text size="sm">
              {poll.group_id ? 'Every question in this poll' : 'The poll'}, its options, and every
              vote cast will be permanently deleted. This can't be undone.
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
    </Stack>
  )
}
