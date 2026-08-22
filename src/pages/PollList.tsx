import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button, Card, Group, Pagination, Stack, Text, Title } from '@mantine/core'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { pollTopic, userTopic, useLiveStream } from '../lib/useLiveStream'
import { LiveConnectionNotice } from '../components/LiveConnectionNotice'
import { PollHeading } from '../components/PollHeading'
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
  // cheap enough to re-read whenever anything on it moves.
  const load = useCallback(async () => {
    const { data, error: rpcError } = await supabase.rpc('list_polls')
    if (rpcError) {
      // A refresh that fails keeps the list already on screen; only a first
      // read that fails leaves nothing to show.
      if (!loaded.current) setError(rpcError.message)
      return false
    }
    loaded.current = true
    // Clears an error from a first read that failed: a failed read is tried
    // again, so a connection that comes back brings the list with it instead
    // of leaving the reader looking at a dead end.
    setError(null)
    setPolls((data as PollListItem[]) ?? [])
    return true
  }, [])

  // Clamped rather than reset: a poll deleted from page three should leave
  // the reader on page three, or on the last page there is if that was it.
  // Derived at render so a live refresh that shortens the list can never
  // leave the page pointing past the end of it.
  const pageCount = Math.max(1, Math.ceil((polls?.length ?? 0) / PAGE_SIZE))
  const current = Math.min(page, pageCount)
  const shown = polls?.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE) ?? []

  // Unlike a single poll, a list has no settled state to stop at: any poll on
  // it can take a vote, and a new invite can add a row. So it watches two
  // different things.
  //
  // The polls in front of the reader, for the counts and the badges. A page
  // of them, not all of them: the list is read whole and paged in the browser
  // (see PAGE_SIZE), and subscribing to every poll somebody has ever been
  // invited to would be an unbounded number of channels to keep a number
  // moving on ten rows they can see.
  //
  // And the reader themselves, for the rows that do not exist yet. A poll
  // they were invited to a moment ago cannot be on the list they are
  // subscribed to, because it was not on the list; the invite is announced to
  // them personally instead.
  //
  // Turning a page changes the set and so costs one more read of the list.
  // That is a deliberate trade against holding tens of channels open, and
  // list_polls() is a single request that answers for every poll at once —
  // the same one request this page used to make every five seconds.
  const topics = shown.map((poll) => pollTopic(poll.id))
  if (session?.user.id) topics.push(userTopic(session.user.id))

  const liveStatus = useLiveStream(topics, load)

  // Which polls on this page have finished without this tab knowing what they
  // decided. Nearly always empty: it fills on a first look at a page and on
  // the read where a poll's results unlock, and is empty on every read in
  // between.
  //
  // Joined into a string to depend on, because `polls` is a fresh array after
  // every read and an effect watching it would re-ask, every time anybody
  // voted anywhere on the list, for an answer that cannot change.
  //
  // A poll that asks several questions is not asked about at all: it has a winner
  // per question and no single one to name, so its badge stays "Results
  // ready" and the answers are named on the question pages themselves.
  const wanted = shown
    .filter((poll) => poll.results_available && poll.question_count < 2 && !winners.has(poll.id))
    .map((poll) => poll.id)
  const wantedKey = wanted.join(',')

  // The winners are their own request rather than a column on list_polls,
  // because a column would re-run every finished poll's election on every
  // read. This asks once per poll, for the polls on screen, and a settled
  // poll never comes back into the question. See 0024_poll_winners.sql.
  useEffect(() => {
    if (!wantedKey) return
    let cancelled = false
    const ids = wantedKey.split(',')

    supabase.rpc('poll_winners', { p_poll_ids: ids }).then(({ data, error: rpcError }) => {
      // A list with no winners named on it is a working list, so a failure
      // here is swallowed: it is also what a browser sees when it is running
      // ahead of the migration that adds the function. The next read asks
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
      <LiveConnectionNotice status={liveStatus} />

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
            {/* The same heading the poll's own page carries, at card size;
                see PollHeading. */}
            <PollHeading
              compact
              title={poll.title}
              description={poll.description}
              createdBy={poll.created_by === session?.user.id ? 'you' : poll.created_by_email}
              mode={poll.mode}
              showVoters={poll.show_voters}
              showBallots={poll.show_ballots}
              turnout={{
                soliciting: poll.soliciting,
                mode: poll.mode,
                votedCount: poll.voted_count,
                invitedCount: poll.invited_count,
                optionCount: poll.option_count,
                questionCount: poll.question_count,
              }}
              state={{
                soliciting: poll.soliciting,
                resultsAvailable: poll.results_available,
                closed: poll.is_closed,
                // Deliberately never asked for on a multi-question poll, so
                // this stays undefined and the badge reads "Results ready".
                winner: winners.get(poll.id),
              }}
            />
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
