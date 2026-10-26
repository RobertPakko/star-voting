import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link, useNavigationType, useSearchParams } from 'react-router-dom'
import {
  ActionIcon,
  Alert,
  Box,
  Button,
  Card,
  Group,
  Pagination,
  Stack,
  Text,
  Title,
  Tooltip,
  useComputedColorScheme,
  VisuallyHidden,
} from '@mantine/core'
import { useMediaQuery, useReducedMotion } from '@mantine/hooks'
import { ArchiveIcon, ArrowCounterClockwiseIcon, PlusIcon } from '@phosphor-icons/react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { removePolls, restorePolls } from '../lib/removedPolls'
import { userTopic, useLiveStream } from '../lib/useLiveStream'
import { BackToList } from '../components/BackToList'
import { Banners } from '../components/Banners'
import { PollHeading, type PollHeadingProps } from '../components/PollHeading'
import { Reveal } from '../components/Reveal'
import { PollListSkeleton } from '../components/Skeletons'
import { PollCards, type ListPage } from '../components/PollCards'
import type { PollListItem } from '../lib/types'
import { winnerLabel } from '../lib/schedule'
import { use24HourTime } from '../lib/clock'
import classes from './PollList.module.css'
import { isPollParam, pollIdFromParam, pollPath } from '../lib/pollId'
import {
  departing,
  fly,
  headingIn,
  landFlight,
  launchFlight,
  peekFlight,
  returnFlight,
  stillEntrances,
  type Flight,
} from '../lib/headingFlight'
import { readListSnapshot, writeListScroll, writeListSnapshot } from '../lib/listCache'
import { usePageTitle } from '../lib/pageTitle'
import { announce } from '../lib/announce'

/** Polls per page. `list_polls()` pages in the database, before its per-poll aggregates. */
const PAGE_SIZE = 10

/**
 * The poll list, or with `?archived` the archived polls. Keyed on which, so
 * switching starts from a skeleton with fresh state. ("Archived" on screen is
 * "removed" in the database and the code.)
 */
export function PollList() {
  const [params] = useSearchParams()
  const removed = params.has('archived')
  usePageTitle(removed ? 'Archived polls' : 'Your polls')
  return <PollListView key={String(removed)} viewingRemoved={removed} />
}

function PollListView({ viewingRemoved }: { viewingRemoved: boolean }) {
  const h24 = use24HourTime()
  const { session, anonymous } = useAuth()
  // For the JS-driven scroll, which the CSS reduced-motion rule can't reach.
  const reducedMotion = useReducedMotion()
  const phone = useMediaQuery('(max-width: 36em)', false, { getInitialValueInEffect: false })
  // The pager is drawn in the opposite scheme to the page.
  const pagerScheme =
    useComputedColorScheme('light', { getInitialValueInEffect: false }) === 'dark'
      ? 'light'
      : 'dark'
  const userId = session?.user.id
  // Returning to the list (the way back, or browser back) restores it as it
  // was left; see lib/listCache.ts. Decided once, on mount.
  const navigationType = useNavigationType()
  const [kept] = useState(() =>
    !viewingRemoved && (peekFlight('list')?.deliberate || navigationType === 'POP')
      ? readListSnapshot(userId)
      : null,
  )
  const returning = useRef<Flight | null>(null)
  const [polls, setPolls] = useState<PollListItem[] | null>(kept?.polls ?? null)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(kept?.page ?? 1)
  // Which page the rows on screen are of; cards are keyed by it (see
  // PollCards). `page` runs ahead of it until the read lands.
  const [rowsOf, setRowsOf] = useState<ListPage>({ removed: false, page: kept?.page ?? 1 })
  const removedView = useRef(viewingRemoved)
  removedView.current = viewingRemoved
  // Size of the archived list, which decides whether the Archived button shows.
  const [removedCount, setRemovedCount] = useState(kept?.removedCount ?? 0)
  // Polls with an archive/restore in flight (their cards are dimmed).
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  // Reads started, and per moved card how many had started when it moved: a
  // read started after that is the first that can come back without it.
  const readsStarted = useRef(0)
  const movedBefore = useRef(new Map<string, number>())
  const [actionError, setActionError] = useState<string | null>(null)
  const [total, setTotal] = useState(kept?.total ?? 0)
  // Kept rows count as loaded: a failed refresh shouldn't replace them with an error.
  const loaded = useRef(!!kept)
  // Refs keep `load` stable, since `useLiveStream` would resubscribe otherwise.
  const chosen = useRef(page)
  chosen.current = page
  const owner = useRef(userId)
  owner.current = userId
  // The list and page last read, as `${removed}:${page}`; null before the first read.
  const fetched = useRef<string | null>(kept ? `false:${kept.page}` : null)

  /** One round trip: a page of polls, their statuses, and the total. */
  const load = useCallback(async () => {
    const asked = chosen.current
    const removed = removedView.current
    const started = ++readsStarted.current
    const { data, error: rpcError } = await supabase.rpc('list_polls', {
      p_limit: PAGE_SIZE,
      p_offset: (asked - 1) * PAGE_SIZE,
      p_removed: removed,
    })
    if (rpcError) {
      if (!loaded.current) setError(rpcError.message)
      return false
    }
    loaded.current = true
    setError(null)
    const rows = (data as PollListItem[]) ?? []
    // The database clamps past-the-end pages, so no rows means an empty list.
    const count = rows[0]?.total_count ?? 0
    // Record the clamped page, so bringing `page` down doesn't re-read.
    const landed = Math.min(asked, Math.max(1, Math.ceil(count / PAGE_SIZE)))
    // Rows and their page in one render: cards are keyed by the page.
    setPolls(rows)
    setRowsOf({ removed, page: landed })
    // Undim cards whose move a read started after it now reflects.
    const settled = [...movedBefore.current].filter(([, before]) => before < started)
    if (settled.length) {
      for (const [id] of settled) movedBefore.current.delete(id)
      setPending((was) => {
        const next = new Set(was)
        for (const [id] of settled) next.delete(id)
        return next
      })
    }
    setTotal(count)
    // The archived count rides on every row; an empty page has none to carry
    // it, so ask separately then.
    let removedTotal: number
    if (rows.length > 0) {
      removedTotal = rows[0].removed_count
    } else {
      const { data: counted } = await supabase.rpc('removed_poll_count')
      removedTotal = typeof counted === 'number' ? counted : 0
    }
    setRemovedCount(removedTotal)
    fetched.current = `${removed}:${landed}`
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

  // On return: restore the scroll, then fly the poll's heading back onto its
  // card, before first paint. The browser's back button launches the flight
  // as the poll page unmounts, which is why it is looked for here.
  useLayoutEffect(() => {
    if (!kept) return
    window.scrollTo(0, kept.scrollY)
    const flight = (returning.current ??= returnFlight(navigationType))
    if (!flight) return
    landFlight(flight)
    const card = document.querySelector(`[data-poll-card="${CSS.escape(flight.id)}"]`)
    const heading = card && headingIn(card, 'card')
    // The card is gone (archived or deleted since): nothing to land on.
    if (!heading) return
    stillEntrances(heading)
    const run = fly(flight, heading)
    let live = true
    void run.arrived.then(() => {
      if (live) void run.settle(heading, 0)
    })
    return () => {
      live = false
      run.cancel()
    }
    // On arrival only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // On leaving (still in the document): save the scroll, and if the address
  // moved to a poll on screen (browser forward), launch its heading's flight.
  useLayoutEffect(() => {
    if (viewingRemoved || !userId) return
    return () => {
      writeListScroll(userId, window.scrollY)
      const opening = pollOpening()
      const card = opening && document.querySelector(`[data-poll-card="${CSS.escape(opening)}"]`)
      if (opening && card) departing('poll', opening, headingIn(card, 'card'))
    }
  }, [viewingRemoved, userId])

  // The list watches the reader's own topic, which is known before any read
  // and carries every change to every poll on their list.
  const topic = session?.user.id ? userTopic(session.user.id) : null

  const { reread } = useLiveStream(topic, load)

  // A page turn or list switch is the one change no signal brings. Waits for
  // the first read, which belongs to the subscription.
  useEffect(() => {
    if (fetched.current === null || fetched.current === `${viewingRemoved}:${page}`) return
    reread()
  }, [page, viewingRemoved, reread])

  /** Archive or restore. The re-read goes through the live queue, absorbing the echo. */
  const move = async (id: string, remove: boolean) => {
    setActionError(null)
    setPending((was) => new Set(was).add(id))
    const failed = await (remove ? removePolls([id]) : restorePolls([id]))
    if (failed) {
      setActionError(failed)
      setPending((was) => {
        const next = new Set(was)
        next.delete(id)
        return next
      })
      return
    }
    // Stays dimmed until `load` sees a list without it.
    movedBefore.current.set(id, readsStarted.current)
    reread()
    // The card (and focus) go; tell a screen reader what happened.
    announce(remove ? 'Archived' : 'Restored to your list')
  }

  // Clamped to the same total the database clamps against.
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const current = Math.min(page, pageCount)

  // Clamp the state too, so a later-growing list doesn't jump the reader forward.
  useEffect(() => {
    if (page > pageCount) setPage(pageCount)
  }, [page, pageCount])

  if (error) {
    return (
      <Text role="alert" c="red" ta="center">
        {error}
      </Text>
    )
  }

  if (!polls) return <PollListSkeleton />

  // Kept rows fade in without the rise: the returning flight measures its
  // card on mount, and a rising list would make it land low.
  return (
    <Reveal rise={!kept}>
      {viewingRemoved && (
        <Box maw={720} mx="auto">
          <BackToList />
        </Box>
      )}
      <Stack maw={720} mx="auto" gap="md">
        {/* Once there are archived polls, the Archived button replaces the
            visible heading (the heading stays for screen readers). */}
        <Group justify="space-between" gap="sm">
          <div>
            {!viewingRemoved && removedCount > 0 ? (
              <>
                <VisuallyHidden>
                  <Title order={1}>Your polls</Title>
                </VisuallyHidden>
                <Button
                  component={Link}
                  to="/?archived"
                  variant="default"
                  leftSection={<ArchiveIcon size={16} aria-hidden />}
                >
                  Archived
                </Button>
              </>
            ) : (
              <Title order={1} size="h2">
                {viewingRemoved ? 'Archived polls' : 'Your polls'}
              </Title>
            )}
          </div>
          {!viewingRemoved && (
            <Button component={Link} to="/new" leftSection={<PlusIcon size={16} aria-hidden />}>
              New poll
            </Button>
          )}
        </Group>

        {anonymous && !viewingRemoved && (
          <Alert color="yellow" variant="light">
            <Text size="sm">
              You're using ChoiceLab without an account, so these polls are only reachable from this
              browser. Sign in to keep them on your account and see them on other devices.
            </Text>
          </Alert>
        )}

        {!viewingRemoved && <Banners />}

        {actionError && (
          <Text role="alert" c="red" size="sm">
            {actionError}
          </Text>
        )}

        {viewingRemoved && polls.length === 0 && (
          <Text c="dimmed" size="sm">
            No archived polls.
          </Text>
        )}
        {!viewingRemoved && polls.length === 0 && (
          <Text c="dimmed" size="sm">
            {removedCount > 0
              ? 'Every poll you’re in has been archived.'
              : anonymous
                ? 'No polls yet. Create one, or open a poll’s link.'
                : 'No polls yet. Create one, wait for an invite, or open a poll’s link.'}
          </Text>
        )}

        <PollCards key={`${rowsOf.removed}:${rowsOf.page}`} turn={rowsOf}>
          {polls.map((poll) => {
            const moving = pending.has(poll.id)
            // Also handed to the poll page, which draws it before its read.
            const heading: PollHeadingProps = {
              title: poll.title,
              description: poll.description,
              // Null for an open poll listed only because this account answered it.
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
                // `undefined` = not settled; null = no winner. A group row is
                // its first question; the badge withholds it via `inGroup`.
                winner: poll.winner_settled ? winnerLabel(poll.winner_name, h24) : undefined,
                inGroup: poll.question_count > 1,
              },
            }
            return (
              <Card
                key={poll.id}
                data-poll-card={poll.id}
                data-leaving={moving || undefined}
                withBorder
                className={`${classes.card} ${moving ? classes.leaving : ''}`}
              >
                {/* A plain left-click launches the heading flight; modified
                    clicks (new tab etc.) are left to the browser. */}
                <Link
                  to={pollPath(poll.id)}
                  state={{ title: poll.title, heading, voted: poll.voted }}
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
                  {/* `reserve` keeps room in the badge row for the pinned action. */}
                  <PollHeading
                    compact
                    tagsClassName={viewingRemoved ? classes.reserveWide : classes.reserve}
                    {...heading}
                  />
                </Link>

                {viewingRemoved ? (
                  <Button
                    variant="default"
                    size="xs"
                    className={classes.action}
                    loading={moving}
                    aria-label={`Restore ${poll.title} to your list`}
                    onClick={() => void move(poll.id, false)}
                    leftSection={<ArrowCounterClockwiseIcon size={14} aria-hidden />}
                  >
                    Restore
                  </Button>
                ) : (
                  <Tooltip
                    label="Archive: move it off your list and stop notifications about it"
                    withArrow
                    multiline
                    w={220}
                  >
                    <ActionIcon
                      variant="subtle"
                      color="gray"
                      className={classes.action}
                      loading={moving}
                      aria-label={`Archive ${poll.title}`}
                      onClick={() => void move(poll.id, true)}
                    >
                      <ArchiveIcon size={18} aria-hidden />
                    </ActionIcon>
                  </Tooltip>
                )}
              </Card>
            )
          })}
        </PollCards>

        {/* A sticky pill at the foot of the screen; see `pager` in PollList.module.css. */}
        {pageCount > 1 && (
          <div className={classes.pager} data-scheme={pagerScheme}>
            <Pagination
              classNames={{ control: classes.pagerControl }}
              total={pageCount}
              value={current}
              size={phone ? 'sm' : 'md'}
              gap={phone ? 4 : 8}
              onChange={(next) => {
                setPage(next)
                window.scrollTo({ top: 0, behavior: reducedMotion ? 'auto' : 'smooth' })
              }}
            />
          </div>
        )}
      </Stack>
    </Reveal>
  )
}

/** The poll the address has just moved to, if it names one (`#/<id>`). */
function pollOpening(): string | null {
  const match = /^#\/([^/?]+)/.exec(window.location.hash)
  if (!match || !isPollParam(match[1])) return null
  return pollIdFromParam(match[1])
}
