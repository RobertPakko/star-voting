import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
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
import { XIcon } from '@phosphor-icons/react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { migrateHiddenPolls, removePolls, restorePolls } from '../lib/removedPolls'
import { userTopic, useLiveStream } from '../lib/useLiveStream'
import { Banners } from '../components/Banners'
import { LiveConnectionNotice } from '../components/LiveConnectionNotice'
import { PollHeading } from '../components/PollHeading'
import { Reveal } from '../components/Reveal'
import { PollListSkeleton } from '../components/Skeletons'
import type { PollListItem } from '../lib/types'
import { winnerLabel } from '../lib/schedule'
import classes from './PollList.module.css'
import { pollPath } from '../lib/pollId'

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

/**
 * The poll list, or the removed polls — which of the two is the address's
 * `?removed`, so the gear menu can link to it. Keyed on it, so the other list
 * starts from the skeleton with its own state instead of the first list's
 * cards standing under the second one's heading.
 */
export function PollList() {
  const [params] = useSearchParams()
  const removed = params.has('removed')
  return <PollListView key={String(removed)} viewingRemoved={removed} />
}

function PollListView({ viewingRemoved }: { viewingRemoved: boolean }) {
  const navigate = useNavigate()
  const { session } = useAuth()
  // Asked here rather than in CSS because the scroll below is asked for from
  // JavaScript, which the global rule in index.css cannot reach.
  const reducedMotion = useReducedMotion()
  const [polls, setPolls] = useState<PollListItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  // Which of the two lists is on screen is the address's, and arrives as a
  // prop: the reader's polls, or the ones they have removed from it. Both are
  // read from `list_polls`, which pages each of them separately, so a page is
  // always full of the list it is a page of — see lib/removedPolls.ts.
  // Deliberately not remembered: a look at what has been put away is a thing
  // you do and then stop doing.
  const removedView = useRef(viewingRemoved)
  removedView.current = viewingRemoved
  // How many polls are in the other list, which is whether the way into it is
  // drawn at all.
  const [removedCount, setRemovedCount] = useState(0)
  // The polls a remove or restore is in flight for, so a card can say so
  // under the press, and whatever the last one said if it was refused.
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  const [actionError, setActionError] = useState<string | null>(null)
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
  // The list and page most recently *asked* for, which is how turning a page
  // or switching lists tells itself apart from the first read. Null until the
  // first read lands.
  const fetched = useRef<string | null>(null)
  // One round trip for a page of polls, their status, and the total. This
  // used to be a select plus one poll_status RPC per poll; which is also what
  // makes it cheap enough to re-read whenever anything on it moves.
  //
  // Open polls somebody else made are on it too, where this account has voted
  // in or confirmed them through their links: the database knows which, from
  // the account on those ballots, so nothing is handed in and the list is the
  // same on every device. See 0075_answered_open_polls_on_the_list.sql.
  const load = useCallback(async () => {
    const asked = chosen.current
    const removed = removedView.current
    const { data, error: rpcError } = await supabase.rpc('list_polls', {
      p_limit: PAGE_SIZE,
      p_offset: (asked - 1) * PAGE_SIZE,
      p_removed: removed,
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
    // The other list's size rides on every row, so an empty read has nowhere
    // to carry it — and a list emptied by removing everything on it is the one
    // whose reader most needs the way back. So that read, and only that one,
    // asks. A database older than the count answers neither, which is none.
    if (rows.length > 0) {
      setRemovedCount(rows[0].removed_count ?? 0)
    } else {
      const { data: counted } = await supabase.rpc('removed_poll_count')
      setRemovedCount(typeof counted === 'number' ? counted : 0)
    }
    // The page these rows are actually of, which is not always the page that
    // was asked for — the database clamps a request past the end. Recording
    // the clamped one is what stops the effect below from reading again the
    // moment `page` is brought down to match.
    fetched.current = `${removed}:${Math.min(asked, Math.max(1, Math.ceil(count / PAGE_SIZE)))}`
    return true
  }, [])

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
  // It carries every change to every poll on the reader's list: the polls
  // they made, the polls they are invited to, and the open polls their account
  // has answered through a link. See 0035_broadcast_polls_to_watchers.sql for
  // the fan-out that makes it so, and 0075_answered_open_polls_on_the_list.sql
  // for the third of those. There used to be a topic per open poll on the page
  // as well, because an open poll's voters were nobody the database could
  // tell; now that their ballots carry their account, they are.
  const topic = session?.user.id ? userTopic(session.user.id) : null

  const { status: liveStatus, reread } = useLiveStream(topic, load)

  // Turning a page, or switching between the two lists, is the one change the
  // socket will not bring: the topic does not depend on which page is on
  // screen, so nothing announces it. The first read is deliberately left to
  // the subscription — see useLiveStream — which is why this waits for one to
  // have landed before it fires.
  useEffect(() => {
    if (fetched.current === null || fetched.current === `${viewingRemoved}:${page}`) return
    reread()
  }, [page, viewingRemoved, reread])

  // What this browser hid before hiding moved into the database, handed over
  // once. It announces itself on the reader's topic, so the list re-reads
  // without being asked; see lib/removedPolls.ts.
  useEffect(() => {
    if (session) void migrateHiddenPolls()
  }, [session])

  // Both directions of the one control. The read afterwards goes through the
  // live stream's own queue, so the echo of the write's broadcast is covered
  // by it rather than costing a second one; see readLedger.ts.
  const move = async (id: string, remove: boolean) => {
    setActionError(null)
    setPending((was) => new Set(was).add(id))
    const failed = await (remove ? removePolls([id]) : restorePolls([id]))
    if (failed) setActionError(failed)
    else reread()
    setPending((was) => {
      const next = new Set(was)
      next.delete(id)
      return next
    })
  }

  // Clamped rather than reset: a poll deleted from page three should leave
  // the reader on page three, or on the last page there is if that was it.
  // Derived at render from the same total the database clamps its own offset
  // against, so the page this claims to be showing and the page it was handed
  // cannot drift apart.
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const current = Math.min(page, pageCount)

  // And brought down in state as well, not only in what is drawn. A `page`
  // left pointing past the end is invisible until the list grows back, at
  // which point the reader would be silently thrown forward to a page they
  // were moved off. This costs no read: `load` already recorded the clamped
  // page as the one on screen.
  useEffect(() => {
    if (page > pageCount) setPage(pageCount)
  }, [page, pageCount])

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
  // and a poll reopened on another device cannot leave a name on this card
  // that its votes no longer support. See
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
          <Title order={2}>{viewingRemoved ? 'Removed polls' : 'Your polls'}</Title>
          <Group gap="xs">
            {/* The way into the removed polls is in the gear menu, which is
                quieter than a button that is on this page for good; only the
                way back lives here, because it is only needed here. */}
            {viewingRemoved && (
              <Button variant="default" onClick={() => navigate('/')}>
                Back to your polls
              </Button>
            )}
            <Button component={Link} to="/polls/new">
              New poll
            </Button>
          </Group>
        </Group>

        {!viewingRemoved && <Banners />}

        {/* What removing did, said where the reader is looking at its result:
            the one consequence of it that is not on screen is the silence. */}
        {viewingRemoved && (
          <Text c="dimmed" size="sm">
            You won&rsquo;t get emails or notifications about these polls. You can still open them,
            and restoring one puts it back on your list.
          </Text>
        )}

        {actionError && (
          <Text c="red" size="sm">
            {actionError}
          </Text>
        )}

        {/* An empty list, and the sentence says which kind: one with nothing
            in it, or one whose every poll was removed, which is a different
            thing and would otherwise read as the app losing the reader's polls
            in front of them. The way back is the sentence's other half, in
            the gear menu. */}
        {viewingRemoved && polls.length === 0 && (
          <Text c="dimmed" size="sm">
            No removed polls.
          </Text>
        )}
        {!viewingRemoved && polls.length === 0 && (
          <Text c="dimmed" size="sm">
            {removedCount > 0
              ? 'Every poll you\u2019re in has been removed from your list.'
              : 'No polls yet. Create one, wait for an invite, or open a poll\u2019s link.'}
          </Text>
        )}

        <Stack gap="md">
          {polls.map((poll) => {
            // Dimmed under the press until the list re-reads without it, which
            // is the only feedback a control has between being pressed and
            // the card it is on going away.
            const moving = pending.has(poll.id)
            return (
              <Card
                key={poll.id}
                withBorder
                className={`${classes.card} ${moving ? classes.leaving : ''}`}
              >
                {/* The heading takes the whole width of the card, so the state
                  badge beside the title sits in the corner like on every other
                  screen. The control is pinned to the bottom right, which is
                  the end of the row of badges, and that row keeps room for it
                  (`reserve`) — so however the badges wrap on a phone, none of
                  them ends up underneath it. */}
                {/* The same heading the poll's own page carries, at card size;
                    see PollHeading. */}
                <Link to={pollPath(poll.id)} className={classes.link}>
                  <PollHeading
                    compact
                    tagsClassName={viewingRemoved ? classes.reserveWide : classes.reserve}
                    title={poll.title}
                    description={poll.description}
                    // Null on an open poll that is here because this account
                    // answered it through its link, which is told no more
                    // about who made it than the link's own page is.
                    createdBy={poll.created_by === session?.user.id ? 'you' : poll.created_by_email}
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

                {/* Remove on the list, Restore on the removed list: one
                    control, whichever way round the card is. The tooltip says
                    what removing costs, because the silence is the part of it
                    nobody would guess from a cross — and nothing here deletes,
                    declines or leaves a poll, which a control on a card of
                    somebody else's poll had better not look like it might. The
                    label names the poll, because a screen reader hearing ten of
                    these needs to know which one it is on. */}
                {viewingRemoved ? (
                  <Button
                    variant="default"
                    size="xs"
                    className={classes.action}
                    loading={moving}
                    aria-label={`Restore ${poll.title} to your list`}
                    onClick={() => void move(poll.id, false)}
                  >
                    Restore
                  </Button>
                ) : (
                  <Tooltip
                    label="Remove from your list and stop notifications about it"
                    withArrow
                    multiline
                    w={220}
                  >
                    <ActionIcon
                      variant="subtle"
                      color="gray"
                      className={classes.action}
                      loading={moving}
                      aria-label={`Remove ${poll.title} from your list`}
                      onClick={() => void move(poll.id, true)}
                    >
                      <XIcon size={18} aria-hidden />
                    </ActionIcon>
                  </Tooltip>
                )}
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
