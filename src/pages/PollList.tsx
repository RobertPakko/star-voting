import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Button, Card, Group, Pagination, Stack, Text, Title } from '@mantine/core'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { useLiveRefresh } from '../lib/useLiveRefresh'
import { BallotsTag, ModeTag, RespondentsTag } from '../components/PollTags'
import { PollListSkeleton } from '../components/Skeletons'
import { badgeColor, countBadge } from '../lib/badgeColors'
import type { PollListItem } from '../lib/types'

/**
 * How many polls a page of the list holds.
 *
 * The list is read whole and paged in the browser rather than by the
 * database: list_polls() returns the polls you can see, which is the polls
 * you were invited to, and that is a number in the tens for anyone this app
 * is for. Paging it server-side would buy nothing and cost the live refresh
 * its one round trip.
 */
const PAGE_SIZE = 10

export function PollList() {
  const { session } = useAuth()
  const [polls, setPolls] = useState<PollListItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  // Whether a read has ever come back; see the note in PublicPoll.
  const loaded = useRef(false)

  // One round trip for the polls and their status. This used to be a
  // select plus one poll_status RPC per poll -- which is also what makes it
  // cheap enough to re-read on a timer.
  const load = useCallback(async () => {
    const { data, error: rpcError } = await supabase.rpc('list_polls')
    if (rpcError) {
      // A refresh that fails keeps the list already on screen; only a first
      // read that fails leaves nothing to show.
      if (!loaded.current) setError(rpcError.message)
      return
    }
    loaded.current = true
    // Clears an error from a first read that failed: this page keeps
    // polling either way, so a connection that comes back brings the list
    // with it instead of leaving the reader looking at a dead end.
    setError(null)
    setPolls((data as PollListItem[]) ?? [])
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Unlike a single poll, a list has no settled state to stop at: any poll
  // on it can take a vote, and a new invite can add a row. It stays live for
  // as long as the tab is in front of someone.
  useLiveRefresh(load)

  if (error) {
    return (
      <Text c="red" ta="center">
        {error}
      </Text>
    )
  }

  if (!polls) return <PollListSkeleton />

  // Clamped rather than reset: a poll deleted from page three should leave
  // the reader on page three, or on the last page there is if that was it.
  // Derived at render so a live refresh that shortens the list can never
  // leave the page pointing past the end of it.
  const pageCount = Math.max(1, Math.ceil(polls.length / PAGE_SIZE))
  const current = Math.min(page, pageCount)
  const shown = polls.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE)

  return (
    <Stack gap="lg" maw={720} mx="auto">
      <Group justify="space-between">
        <Title order={2}>Your polls</Title>
        <Button component={Link} to="/polls/new">
          New poll
        </Button>
      </Group>

      {polls.length === 0 && (
        <Text c="dimmed" size="sm">
          No polls yet. Create one, or wait for an invite.
        </Text>
      )}

      <Stack gap="sm">
        {shown.map((poll) => (
          <Card
            key={poll.id}
            withBorder
            component={Link}
            to={`/polls/${poll.id}`}
            style={{ textDecoration: 'none' }}
          >
            <Stack gap={4}>
              {/* Where the poll has got to, on the right of the title: it is
                  the one thing on the card that is about this poll's own
                  progress rather than its terms, and the only thing worth
                  reading before deciding whether to open it. */}
              <Group justify="space-between" wrap="nowrap" align="flex-start" gap="sm">
                <Text fw={600} c="var(--mantine-color-text)">
                  {poll.title}
                </Text>
                <StateBadge poll={poll} />
              </Group>
              {poll.description && (
                <Text size="sm" c="dimmed">
                  {poll.description}
                </Text>
              )}
              <Text size="xs" c="dimmed">
                {poll.created_by === session?.user.id
                  ? 'Created by you'
                  : `Created by ${poll.created_by_email}`}
              </Text>

              {/* Four badges, always the same four, in the same order on
                  every card: how many have answered, then who can see what,
                  then who was allowed in. The count leads because it is the
                  only one that moves; the access mode anchors the end
                  because it is the one that never does.

                  The poll page's tag row carries a fifth -- where the
                  options came from -- which is dropped here. It is worth
                  reading on the poll itself and it is the one setting nobody
                  scans a list for, and a row of five tags under a title had
                  stopped being read at all. */}
              <Group gap="xs" mt={4}>
                <Badge {...countBadge}>{turnout(poll)}</Badge>
                <RespondentsTag showVoters={poll.show_voters} />
                <BallotsTag showBallots={poll.show_ballots} />
                <ModeTag mode={poll.mode} />
              </Group>
            </Stack>
          </Card>
        ))}
      </Stack>

      {/* Only once there is a second page to go to. */}
      {pageCount > 1 && (
        <Group justify="center">
          <Pagination
            total={pageCount}
            value={current}
            onChange={(next) => {
              setPage(next)
              // The list is taller than a phone; landing halfway down the
              // new page reads as nothing having happened.
              window.scrollTo({ top: 0, behavior: 'smooth' })
            }}
          />
        </Group>
      )}
    </Stack>
  )
}

/**
 * How many have answered so far -- which is not the same question at every
 * stage, and the badge says whichever one the poll is actually asking.
 *
 * It stays on the card after the poll closes. It used to be replaced by
 * "Results ready" the moment they were, which threw away the turnout the
 * result was reached on at exactly the point it became a permanent fact
 * about the poll -- and said nothing the state badge does not now say
 * better.
 */
function turnout(poll: PollListItem): string {
  if (poll.soliciting) {
    // Turnout is zero and stays zero until the list is settled, so this
    // stage counts what is actually moving: the options coming in.
    return `${poll.option_count} ${poll.option_count === 1 ? 'option' : 'options'} so far`
  }
  if (poll.mode === 'open') {
    // No invite list, so no denominator to count towards.
    return `${poll.voted_count} ${poll.voted_count === 1 ? 'response' : 'responses'}`
  }
  return `${poll.voted_count}/${poll.invited_count} voted`
}

/**
 * Where the poll has got to, in one badge: collecting its options, waiting
 * on votes, or finished — and a finished poll names the option that won,
 * because that is the answer the whole poll was for and the reason anybody
 * opens it again afterwards.
 *
 * The name comes from list_polls(), which runs the same star_round() the
 * results page runs, so the badge and the poll page cannot disagree about
 * who won. It is absent in three cases, and all three land on the same
 * neutral wording rather than guessing: a genuine tie that elected nobody, a
 * poll closed before anyone voted, and a browser holding this code against a
 * database whose list_polls predates the column.
 */
function StateBadge({ poll }: { poll: PollListItem }) {
  if (poll.soliciting) {
    return (
      <Badge color={badgeColor.collectingOptions} variant="light" style={{ flexShrink: 0 }}>
        Collecting options
      </Badge>
    )
  }

  if (poll.results_available) {
    return (
      <Badge
        color={badgeColor.done}
        variant="light"
        maw={220}
        style={{ flexShrink: 1 }}
        title={poll.winner_name ?? undefined}
      >
        {poll.winner_name ? `Winner: ${poll.winner_name}` : 'Results ready'}
      </Badge>
    )
  }

  if (poll.is_closed) {
    // Closed with nothing in it: there is no result to name, and never will
    // be unless the creator resets it.
    return (
      <Badge color={badgeColor.closed} variant="light" style={{ flexShrink: 0 }}>
        Closed
      </Badge>
    )
  }

  return (
    <Badge color={badgeColor.outstanding} variant="light" style={{ flexShrink: 0 }}>
      Pending
    </Badge>
  )
}
