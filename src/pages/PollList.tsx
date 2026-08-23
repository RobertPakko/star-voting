import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button, Card, Group, Pagination, Stack, Text, Title } from '@mantine/core'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { userTopic, useLiveStream } from '../lib/useLiveStream'
import { LiveConnectionNotice } from '../components/LiveConnectionNotice'
import { PollHeading } from '../components/PollHeading'
import { PollListSkeleton } from '../components/Skeletons'
import { knownWinners, rememberWinner } from '../lib/settled'
import type { PollListItem } from '../lib/types'

/**
 * How many polls a page of the list holds.
 *
 * The page is taken in the database, not here: `list_polls()` is handed this
 * and an offset, and answers with those rows and the total. It used to return
 * everything and let the browser slice it, on the grounds that a poll history
 * is a number in the tens — but the expensive half of that function is a set
 * of correlated subqueries run *per poll*, so reading it whole meant paying
 * for every poll you had ever been invited to in order to draw ten of them.
 * See 0036_page_the_poll_list.sql.
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
  // How many polls there are in total, which only a read can tell us: it
  // arrives on every row (see PollListItem.total_count) because that is the
  // only place a set-returning function can put it.
  const [total, setTotal] = useState(0)
  // Whether a read has ever come back; see the note in PublicPoll.
  const loaded = useRef(false)
  // The page the rows on screen were read for. Kept in a ref so `load` never
  // changes identity — `useLiveStream` calls whatever it holds, and a fresh
  // function every render would be a fresh subscription every render.
  const chosen = useRef(page)
  chosen.current = page
  // The page most recently *asked* for, which is how turning a page tells
  // itself apart from the first read. 0 until the first read lands.
  const fetched = useRef(0)

  // One round trip for a page of polls, their status, and the total. This
  // used to be a select plus one poll_status RPC per poll; which is also what
  // makes it cheap enough to re-read whenever anything on it moves.
  const load = useCallback(async () => {
    const asked = chosen.current
    const { data, error: rpcError } = await supabase.rpc('list_polls', {
      p_limit: PAGE_SIZE,
      p_offset: (asked - 1) * PAGE_SIZE,
    })
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
    const rows = (data as PollListItem[]) ?? []
    setPolls(rows)
    // No rows means no total to read off one, and that can only be an empty
    // list: the database clamps a page request past the end onto the last
    // page there is, so a page that comes back empty is a list with nothing
    // in it rather than a page number that overshot.
    const count = rows[0]?.total_count ?? 0
    setTotal(count)
    // The page these rows are actually of, which is not always the page that
    // was asked for — the database clamps a request past the end. Recording
    // the clamped one is what stops the effect below from reading again the
    // moment `page` is brought down to match.
    fetched.current = Math.min(asked, Math.max(1, Math.ceil(count / PAGE_SIZE)))
    return true
  }, [])

  // Turning a page is the one change the socket will not bring: the topic
  // does not depend on which page is on screen, so nothing announces it. The
  // first read is deliberately left to the subscription — see useLiveStream
  // — which is why this waits for one to have landed before it fires.
  useEffect(() => {
    if (fetched.current === 0 || fetched.current === page) return
    load()
  }, [page, load])

  // Clamped rather than reset: a poll deleted from page three should leave
  // the reader on page three, or on the last page there is if that was it.
  // Derived at render from the same total the database clamps its own offset
  // against, so the page this claims to be showing and the page it was handed
  // cannot drift apart.
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const current = Math.min(page, pageCount)
  const shown = polls ?? []

  // And brought down in state as well, not only in what is drawn. A `page`
  // left pointing past the end is invisible until the list grows back, at
  // which point the reader would be silently thrown forward to a page they
  // were moved off. This costs no read: `load` already recorded the clamped
  // page as the one on screen.
  useEffect(() => {
    if (page > pageCount) setPage(pageCount)
  }, [page, pageCount])

  // Unlike a single poll, a list has no settled state to stop at: any poll on
  // it can take a vote, and a new invite can add a row. So it watches one
  // thing, and that thing is the reader rather than the polls.
  //
  // Watching the polls would mean holding one channel per row, which the page
  // cannot even name until it has read the list — so it would read once to
  // learn them, subscribe, and read again on subscribing. The reader's own
  // topic is known from the session before anything is read, so the page
  // subscribes on mount and its first read is its only read. It also does not
  // change when the reader turns a page, so a page turn costs the one read it
  // genuinely needs and no re-subscription on top of it.
  //
  // It carries every change to every poll on the list, invites included; see
  // 0035_broadcast_polls_to_watchers.sql for the fan-out that makes it so.
  const topics = session?.user.id ? [userTopic(session.user.id)] : []

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
