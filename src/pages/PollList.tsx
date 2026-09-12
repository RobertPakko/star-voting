import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ActionIcon,
  Button,
  Card,
  Group,
  Pagination,
  Stack,
  Text,
  Title,
  Tooltip,
} from '@mantine/core'
import { useReducedMotion } from '@mantine/hooks'
import { EyeIcon, EyeSlashIcon } from '@phosphor-icons/react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { pruneHiddenPolls, setPollHidden, useHiddenPolls } from '../lib/hiddenPolls'
import { userTopic, useLiveStream } from '../lib/useLiveStream'
import { LiveConnectionNotice } from '../components/LiveConnectionNotice'
import { PollHeading } from '../components/PollHeading'
import { Reveal } from '../components/Reveal'
import { PollListSkeleton } from '../components/Skeletons'
import type { PollListItem } from '../lib/types'
import { winnerLabel } from '../lib/schedule'
import classes from './PollList.module.css'

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
  // Asked here rather than in CSS because the scroll below is asked for from
  // JavaScript, which the global rule in index.css cannot reach.
  const reducedMotion = useReducedMotion()
  const [polls, setPolls] = useState<PollListItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  // The polls this browser keeps off the list, which is the reader's own
  // housekeeping and lives nowhere but their storage; see lib/hiddenPolls.ts.
  const hidden = useHiddenPolls()
  // Whether they are being looked at anyway. Deliberately not remembered: a
  // peek at what has been put away is a thing you do and then stop doing, and
  // a reader who reloads onto a list they thought they had tidied would have
  // to tidy it again. Hiding itself survives; looking at it does not.
  const [revealed, setRevealed] = useState(false)
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
    // A page that holds the whole list is the one read that can tell a hidden
    // poll that has since been deleted from a hidden poll on another page, so
    // it is the one read allowed to sweep the stored ids; see
    // pruneHiddenPolls, which is doing nothing at all on most reads.
    if (count <= PAGE_SIZE) pruneHiddenPolls(rows.map((row) => row.id))
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
  // The page, less whatever is being kept off it.
  //
  // Filtered here rather than paged around: `list_polls` counts every poll the
  // reader is in, hidden or not, so the pager still reports the same pages and
  // a poll stays on the page it was on. The alternative — pages that close up
  // over what is hidden — would mean a poll's place on the list moving because
  // of something done to a different poll, and a page whose contents depend on
  // what a browser happens to be storing. The cost is that hiding four polls
  // leaves six on a page of ten, which reads as exactly what it is.
  const visible = revealed ? shown : shown.filter((poll) => !hidden.has(poll.id))

  // And brought down in state as well, not only in what is drawn. A `page`
  // left pointing past the end is invisible until the list grows back, at
  // which point the reader would be silently thrown forward to a page they
  // were moved off. This costs no read: `load` already recorded the clamped
  // page as the one on screen.
  useEffect(() => {
    if (page > pageCount) setPage(pageCount)
  }, [page, pageCount])

  // Nothing hidden, nothing to reveal. Without this, bringing the last hidden
  // poll back would leave the control pressed with nothing behind it — and the
  // next poll hidden after that would stay on screen, under a button offering
  // to show it.
  useEffect(() => {
    if (hidden.size === 0) setRevealed(false)
  }, [hidden])

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

  // The winner of a finished poll arrives on the row that draws the card.
  //
  // It used to be a second request — `poll_winners()`, asked for the finished
  // polls on screen whose result this tab could not already name — and a
  // module-level cache to stop it being asked twice. Both are gone. The
  // objection to a column was that it would re-run every finished poll's
  // election on every read of a list that re-reads itself whenever anything
  // on it moves; what `list_polls` carries now is not an election but a
  // column the database settled once, when the poll finished. So the badge is
  // final on the first paint, there is nothing in flight for it to wait on,
  // and a poll reset on another device cannot leave a name on this card that
  // its votes no longer support. See
  // 0047_the_winner_is_kept_with_the_poll.sql.

  if (error) {
    return (
      <Text c="red" ta="center">
        {error}
      </Text>
    )
  }

  if (!polls) return <PollListSkeleton />

  // Faded in over the shape that was standing in for it, rather than swapped
  // for it between two frames; see Reveal.
  return (
    <Reveal>
      <Stack maw={720} mx="auto" gap="md">
        <LiveConnectionNotice status={liveStatus} />

        <Group justify="space-between">
          <Title order={2}>Your polls</Title>
          <Group gap="xs">
            {/* Only there when something is hidden, because that is the only
                state in which it has anything to say — and its absence is how
                a reader who has never hidden a poll never learns there is a
                mode they might be in. It counts what is hidden across the whole
                list rather than on this page: the number is what makes the
                control worth reading, and a poll put away on page three is
                still put away when page one is on screen.

                Left of New poll, which stays where it has always been. This is
                about the list already there; that one leaves it. */}
            {hidden.size > 0 && (
              <Button variant="default" onClick={() => setRevealed((was) => !was)}>
                {revealed ? 'Hide again' : `Show hidden (${hidden.size})`}
              </Button>
            )}
            <Button component={Link} to="/polls/new">
              New poll
            </Button>
          </Group>
        </Group>

        {polls.length === 0 && (
          <Text c="dimmed" size="sm">
            No polls yet. Create one, or wait for an invite.
          </Text>
        )}

        {/* Polls, all of them hidden. Said out loud rather than left as a gap
            under the heading: an empty space says the list is empty, which is
            a different thing and would be the app losing the reader's polls in
            front of them. The control that brings them back is the sentence's
            other half, one row up. */}
        {polls.length > 0 && visible.length === 0 && (
          <Text c="dimmed" size="sm">
            {pageCount > 1 ? 'Every poll on this page is hidden.' : 'Every poll here is hidden.'}
          </Text>
        )}

        <Stack gap="md">
          {visible.map((poll) => {
            // Only ever true while they are being looked at; a hidden poll is
            // otherwise not on screen to say so.
            const isHidden = hidden.has(poll.id)
            return (
              <Card
                key={poll.id}
                withBorder
                className={`${classes.card} ${isHidden ? classes.hidden : ''}`}
              >
                {/* The heading and the control, on one row, the control at the
                  bottom of it — which on every card is alongside the badges,
                  the last thing the row is made of. Placed in the flow rather
                  than pinned to the corner: the badges wrap on a phone, and a
                  button floating over the end of a wrapped row is a button
                  sitting on top of what the card was trying to say. */}
                <Group align="flex-end" wrap="nowrap" gap="xs">
                  {/* The same heading the poll's own page carries, at card size;
                    see PollHeading. */}
                  <Link to={`/polls/${poll.id}`} className={classes.link}>
                    <PollHeading
                      compact
                      title={poll.title}
                      description={poll.description}
                      createdBy={
                        poll.created_by === session?.user.id ? 'you' : poll.created_by_email
                      }
                      mode={poll.mode}
                      showVoters={poll.show_voters}
                      showBallots={poll.show_ballots}
                      turnout={{
                        soliciting: poll.soliciting,
                        mode: poll.mode,
                        votedCount: poll.voted_count,
                        invitedCount: poll.invited_count,
                        confirmedCount: poll.confirmed_count,
                        optionCount: poll.option_count,
                        questionCount: poll.question_count,
                      }}
                      state={{
                        soliciting: poll.soliciting,
                        resultsAvailable: poll.results_available,
                        closed: poll.is_closed,
                        // `undefined` rather than null where the database has not
                        // settled an answer — including a database old enough not to
                        // carry the columns at all — because null is a real answer
                        // here and means a poll that elected nobody.
                        //
                        // A group's row on this list *is* its first question, so this
                        // is that question's winner rather than the poll's. The badge
                        // withholds it on `inGroup`, in one place for all three
                        // screens, rather than leaving three callers to remember.
                        winner: poll.winner_settled
                          ? winnerLabel(poll.winner_name ?? null)
                          : undefined,
                        inGroup: poll.question_count > 1,
                      }}
                    />
                  </Link>

                  {/* An eye rather than a cross, and the wording is "list"
                    rather than "hide" alone: nothing here deletes, declines or
                    leaves a poll, and a control on a card of somebody else's
                    poll had better not look like it might. The label names the
                    poll, because a screen reader hearing ten of these needs to
                    know which one it is on. */}
                  <Tooltip label={isHidden ? 'Show on this list' : 'Hide from this list'} withArrow>
                    <ActionIcon
                      variant="subtle"
                      color="gray"
                      className={classes.hide}
                      aria-label={
                        isHidden
                          ? `Show ${poll.title} on this list`
                          : `Hide ${poll.title} from this list`
                      }
                      onClick={() => setPollHidden(poll.id, !isHidden)}
                    >
                      {isHidden ? (
                        <EyeIcon size={18} aria-hidden />
                      ) : (
                        <EyeSlashIcon size={18} aria-hidden />
                      )}
                    </ActionIcon>
                  </Tooltip>
                </Group>
              </Card>
            )
          })}
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
                window.scrollTo({ top: 0, behavior: reducedMotion ? 'auto' : 'smooth' })
              }}
            />
          </Group>
        )}
      </Stack>
    </Reveal>
  )
}
