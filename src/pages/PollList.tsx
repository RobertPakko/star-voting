import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button, Card, Group, Pagination, Stack, Text, Title } from '@mantine/core'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { useLiveRefresh } from '../lib/useLiveRefresh'
import { PollStateBadge, PollTags } from '../components/PollTags'
import { PollListSkeleton } from '../components/Skeletons'
import { knownWinners, rememberWinner } from '../lib/settled'
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
  // Winners this tab has learned, seeded from what it learned before this
  // page was last mounted. The Map in lib/settled.ts is the copy that
  // outlives the component; this one is what re-renders when it grows.
  const [winners, setWinners] = useState<ReadonlyMap<string, string | null>>(
    () => new Map(knownWinners()),
  )
  // Whether a read has ever come back; see the note in PublicPoll.
  const loaded = useRef(false)

  // One round trip for the polls and their status. This used to be a
  // select plus one poll_status RPC per poll; which is also what makes it
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

  // Clamped rather than reset: a poll deleted from page three should leave
  // the reader on page three, or on the last page there is if that was it.
  // Derived at render so a live refresh that shortens the list can never
  // leave the page pointing past the end of it.
  const pageCount = Math.max(1, Math.ceil((polls?.length ?? 0) / PAGE_SIZE))
  const current = Math.min(page, pageCount)
  const shown = polls?.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE) ?? []

  // Which polls on this page have finished without this tab knowing what they
  // decided. Nearly always empty: it fills on a first look at a page and on
  // the tick a poll's results unlock, and is empty on every tick in between.
  //
  // Joined into a string to depend on, because `polls` is a fresh array on
  // every refresh tick and an effect watching it would re-ask every few
  // seconds for an answer that cannot change.
  const wanted = shown
    .filter((poll) => poll.results_available && !winners.has(poll.id))
    .map((poll) => poll.id)
  const wantedKey = wanted.join(',')

  // The winners are their own request rather than a column on list_polls,
  // because a column would re-run every finished poll's election on every
  // tick. This asks once per poll, for the polls on screen, and a settled
  // poll never comes back into the question. See 0024_poll_winners.sql.
  useEffect(() => {
    if (!wantedKey) return
    let cancelled = false
    const ids = wantedKey.split(',')

    supabase.rpc('poll_winners', { p_poll_ids: ids }).then(({ data, error: rpcError }) => {
      // A list with no winners named on it is a working list, so a failure
      // here is swallowed: it is also what a browser sees when it is running
      // ahead of the migration that adds the function. The next tick asks
      // again, since nothing was remembered.
      if (rpcError || !data) return
      const answered = data as { poll_id: string; winner_name: string | null }[]
      for (const row of answered) rememberWinner(row.poll_id, row.winner_name)
      if (cancelled) return
      setWinners(new Map(knownWinners()))
    })

    return () => {
      cancelled = true
    }
  }, [wantedKey])

  if (error) {
    return (
      <Text c="red" ta="center">
        {error}
      </Text>
    )
  }

  if (!polls) return <PollListSkeleton />

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
                {/* The side of this row that gives: the badge beside it is
                    sized to the name it carries, so a title too long for
                    what is left wraps rather than squeezing it. `minWidth`
                    lets it wrap past its longest word, which a title with
                    no spaces in it otherwise would not. */}
                <Text
                  fw={600}
                  c="var(--mantine-color-text)"
                  style={{ minWidth: 0, wordBreak: 'break-word' }}
                >
                  {poll.title}
                </Text>
                <PollStateBadge
                  soliciting={poll.soliciting}
                  resultsAvailable={poll.results_available}
                  closed={poll.is_closed}
                  winner={winners.get(poll.id)}
                />
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

              {/* The same four badges, in the same order, that the poll's
                  own page shows above its ballot. */}
              <div style={{ marginTop: 4 }}>
                <PollTags
                  mode={poll.mode}
                  showVoters={poll.show_voters}
                  showBallots={poll.show_ballots}
                  turnout={{
                    soliciting: poll.soliciting,
                    mode: poll.mode,
                    votedCount: poll.voted_count,
                    invitedCount: poll.invited_count,
                    optionCount: poll.option_count,
                  }}
                />
              </div>
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
