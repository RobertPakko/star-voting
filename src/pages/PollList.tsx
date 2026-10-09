import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link, useNavigate, useNavigationType, useSearchParams } from 'react-router-dom'
import {
  ActionIcon,
  Alert,
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
import { PollHeading, type PollHeadingProps } from '../components/PollHeading'
import { Reveal } from '../components/Reveal'
import { PollListSkeleton } from '../components/Skeletons'
import type { PollListItem } from '../lib/types'
import { winnerLabel } from '../lib/schedule'
import { use24HourTime } from '../lib/clock'
import classes from './PollList.module.css'
import { pollPath } from '../lib/pollId'
import { fly, headingIn, landFlight, launchFlight, peekFlight } from '../lib/headingFlight'
import { readListSnapshot, writeListScroll, writeListSnapshot } from '../lib/listCache'
import { usePageTitle } from '../lib/pageTitle'
import { announce } from '../lib/announce'

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
  usePageTitle(removed ? 'Removed polls' : 'Your polls')
  return <PollListView key={String(removed)} viewingRemoved={removed} />
}

function PollListView({ viewingRemoved }: { viewingRemoved: boolean }) {
  const h24 = use24HourTime()
  const navigate = useNavigate()
  const { session, anonymous } = useAuth()
  // Asked here rather than in CSS because the scroll below is asked for from
  // JavaScript, which the global rule in index.css cannot reach.
  const reducedMotion = useReducedMotion()
  const userId = session?.user.id
  // A return to the list — its own back control on a poll, or the browser's
  // back button — draws the list as it was left rather than starting over;
  // see lib/listCache.ts. Taken once, on mount: this is how the page starts,
  // not something it goes on consulting.
  const navigationType = useNavigationType()
  const [returning] = useState(() => (viewingRemoved ? null : peekFlight('list')))
  const [kept] = useState(() =>
    !viewingRemoved && (returning || navigationType === 'POP') ? readListSnapshot(userId) : null,
  )
  const [polls, setPolls] = useState<PollListItem[] | null>(kept?.polls ?? null)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(kept?.page ?? 1)
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
  const [removedCount, setRemovedCount] = useState(kept?.removedCount ?? 0)
  // The polls a remove or restore is in flight for, so a card can say so
  // under the press, and whatever the last one said if it was refused.
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  const [actionError, setActionError] = useState<string | null>(null)
  // How many polls there are in total, which only a read can tell us: it
  // arrives on every row (see PollListItem.total_count) because that is the
  // only place a set-returning function can put it.
  const [total, setTotal] = useState(kept?.total ?? 0)
  // Whether a read has ever come back; see the note in PublicPoll. Rows kept
  // from the last visit count: they are on screen, and a refresh that fails
  // should leave them there rather than replace them with an error.
  const loaded = useRef(!!kept)
  // The page the rows on screen were read for. Kept in a ref so `load` never
  // changes identity — `useLiveStream` calls whatever it holds, and a fresh
  // function every render would be a fresh subscription every render.
  const chosen = useRef(page)
  chosen.current = page
  // Whose list the rows are, for the snapshot `load` leaves behind; a ref for
  // the reason `chosen` is one.
  const owner = useRef(userId)
  owner.current = userId
  // The list and page most recently *asked* for, which is how turning a page
  // or switching lists tells itself apart from the first read. Null until the
  // first read lands.
  const fetched = useRef<string | null>(kept ? `false:${kept.page}` : null)
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
    let removedTotal: number
    if (rows.length > 0) {
      removedTotal = rows[0].removed_count ?? 0
    } else {
      const { data: counted } = await supabase.rpc('removed_poll_count')
      removedTotal = typeof counted === 'number' ? counted : 0
    }
    setRemovedCount(removedTotal)
    // The page these rows are actually of, which is not always the page that
    // was asked for — the database clamps a request past the end. Recording
    // the clamped one is what stops the effect below from reading again the
    // moment `page` is brought down to match.
    const landed = Math.min(asked, Math.max(1, Math.ceil(count / PAGE_SIZE)))
    fetched.current = `${removed}:${landed}`
    // Left for the walk back from a poll; see lib/listCache.ts.
    if (!removed && owner.current)
      writeListSnapshot({
        userId: owner.current,
        polls: rows,
        total: count,
        removedCount: removedTotal,
        page: landed,
      })
    return true
  }, [])

  // Back where the reader left it, and the heading of the poll they were on
  // flying back onto its card. Before the first paint, so the list is never
  // seen at the top and then moved; and the scroll first, because the flight
  // aims at where the card is on screen.
  useLayoutEffect(() => {
    if (!kept) return
    window.scrollTo(0, kept.scrollY)
    if (!returning) return
    landFlight(returning)
    const card = document.querySelector(`[data-poll-card="${CSS.escape(returning.id)}"]`)
    const heading = card && headingIn(card, 'card')
    // Not on this page of the list any more — removed, or deleted, since the
    // reader left — so there is nowhere for it to land and nothing flies.
    if (!heading) return
    const run = fly(returning, heading)
    let live = true
    void run.arrived.then(() => {
      if (live) void run.settle(heading, 0)
    })
    return () => {
      live = false
      run.cancel()
    }
  }, [kept, returning])

  // How far down the list was, written as the reader leaves it: in a layout
  // effect's cleanup, which runs while the list is still in the document and
  // the page is still scrolled where the reader had it.
  useLayoutEffect(() => {
    if (viewingRemoved || !userId) return
    return () => writeListScroll(userId, window.scrollY)
  }, [viewingRemoved, userId])

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
    else {
      reread()
      // The card goes, and focus with it; this is the only trace of the press
      // a screen reader would otherwise be left with.
      announce(remove ? 'Removed from your list' : 'Restored to your list')
    }
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
      <Text role="alert" c="red" ta="center">
        {error}
      </Text>
    )
  }

  if (!polls) return <PollListSkeleton />

  // Faded in over the shape that was standing in for it, rather than swapped
  // for it between two frames; see Reveal. Kept rows fade in too, under the
  // title flying back onto its card: there was no shape before them, but
  // there was a poll's page, and a list that appeared between two frames in
  // its place would be the one swap on the way back.
  return (
    <Reveal>
      <Stack maw={720} mx="auto" gap="md">
        <LiveConnectionNotice status={liveStatus} />

        <Group justify="space-between">
          <Title order={1} size="h2">
            {viewingRemoved ? 'Removed polls' : 'Your polls'}
          </Title>
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

        {/* The one thing a list made without an account most needs saying:
            it lives in this browser's session, and nothing else knows it is
            theirs. Clearing the site's data, or another device, is a list
            nobody can get back. Signing in is how it stops being that. */}
        {anonymous && !viewingRemoved && (
          <Alert color="yellow" variant="light">
            <Text size="sm">
              You're using STAR Voting without an account, so these polls are only reachable from
              this browser. Sign in to keep them on your account and see them on other devices.
            </Text>
          </Alert>
        )}

        {!viewingRemoved && <Banners />}

        {actionError && (
          <Text role="alert" c="red" size="sm">
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
              : anonymous
                ? 'No polls yet. Create one, or open a poll\u2019s link.'
                : 'No polls yet. Create one, wait for an invite, or open a poll\u2019s link.'}
          </Text>
        )}

        <Stack gap="md">
          {polls.map((poll) => {
            // Dimmed under the press until the list re-reads without it, which
            // is the only feedback a control has between being pressed and
            // the card it is on going away.
            const moving = pending.has(poll.id)
            // The same heading the poll's own page carries, at card size; see
            // PollHeading. Built once, because it is also handed to the page
            // the card opens, which draws it before it has read the poll.
            const heading: PollHeadingProps = {
              title: poll.title,
              description: poll.description,
              // Null on an open poll that is here because this account
              // answered it through its link, which is told no more about who
              // made it than the link's own page is.
              createdBy: poll.created_by === session?.user.id ? 'you' : poll.created_by_email,
              mode: poll.mode,
              showVoters: poll.show_voters,
              showBallots: poll.show_ballots,
              turnout: {
                soliciting: poll.soliciting,
                mode: poll.mode,
                votedCount: poll.voted_count,
                invitedCount: poll.invited_count,
                confirmedCount: poll.confirmed_count,
                optionCount: poll.option_count,
                questionCount: poll.question_count,
              },
              state: {
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
                  ? winnerLabel(poll.winner_name ?? null, h24)
                  : undefined,
                inGroup: poll.question_count > 1,
              },
            }
            return (
              <Card
                key={poll.id}
                data-poll-card={poll.id}
                withBorder
                className={`${classes.card} ${moving ? classes.leaving : ''}`}
              >
                {/* The heading takes the whole width of the card, so the state
                  badge beside the title sits in the corner like on every other
                  screen. The control is pinned to the bottom right, which is
                  the end of the row of badges, and that row keeps room for it
                  (`reserve`) — so however the badges wrap on a phone, none of
                  them ends up underneath it. */}
                {/* The heading carried along in the navigation, so the page it
                    opens draws it from the press; and the press flies it to
                    the top of the page while the poll is read. A click that
                    asks for a new tab or window is left to the browser. See
                    lib/headingFlight.ts.

                    `listId` is what puts a way back on the poll's page, and
                    the card that way back lands on: a poll opened from the
                    list returns to it, and one opened from anywhere else has
                    nowhere to return to. Not from the removed polls, whose
                    way back would land on a list they are not on. */}
                <Link
                  to={pollPath(poll.id)}
                  state={{
                    title: poll.title,
                    heading,
                    listId: viewingRemoved ? undefined : poll.id,
                  }}
                  className={classes.link}
                  onClick={(event) => {
                    if (
                      event.button !== 0 ||
                      event.metaKey ||
                      event.ctrlKey ||
                      event.shiftKey ||
                      event.altKey
                    )
                      return
                    launchFlight('poll', poll.id, headingIn(event.currentTarget, 'card'))
                  }}
                >
                  <PollHeading
                    compact
                    tagsClassName={viewingRemoved ? classes.reserveWide : classes.reserve}
                    {...heading}
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
