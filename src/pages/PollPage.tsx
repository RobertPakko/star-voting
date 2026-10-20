import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Box, Button, Stack, Text, Title } from '@mantine/core'
import { ArrowLeftIcon } from '@phosphor-icons/react'
import { Link, Navigate, useLocation, useParams } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { forgetSampleBallots, isSampleId } from '../lib/samplePoll'
import { forgetSampleDrafts } from '../lib/ballotDraft'
import { questionsCovered, readPollPage } from '../lib/pollPage'
import { pollTopic, useLiveStream, type LiveStream } from '../lib/useLiveStream'
import { rememberDestination } from '../lib/shareLink'
import { PollDetail } from './PollDetail'
import { PublicPoll } from './PublicPoll'
import { PollPageSkeleton } from '../components/Skeletons'
import type { PollRead } from '../lib/types'
import { pollIdFromParam } from '../lib/pollId'
import { useClearPollNotifications } from '../lib/badge'
import { usePageTitle } from '../lib/pageTitle'
import {
  departing,
  fly,
  headingIn,
  landFlight,
  peekFlight,
  stillEntrances,
  type FlightRun,
} from '../lib/headingFlight'
import { readListSnapshot } from '../lib/listCache'
import type { PollHeadingProps } from '../components/PollHeading'
import { motionMs } from '../lib/motion'
import { BackToList } from '../components/BackToList'
import { Reveal } from '../components/Reveal'
import { preloadCards } from '../components/deferred'

/**
 * Once a poll page's skeleton is drawn, it stays at least this long, so a
 * read landing a few frames later doesn't flicker. A read back before the
 * skeleton appeared (usual when the heading flight covers it) isn't held.
 */
const SKELETON_MIN_MS = 400

/**
 * A poll at its one address, rendered as whichever reading this reader may
 * see: `PollDetail` for an account in the poll, `PublicPoll` for everyone
 * else. One `poll_page` read decides and draws at once (see lib/pollPage.ts),
 * and refuses a missing poll and a forbidden one identically.
 *
 * This route also owns the live subscriptions (one `QuestionWatch` per
 * question on screen or beside it, so neighbours are read ahead) and the
 * heading flight in from the list. See "Live updates" and "A poll's heading
 * flies between the list and its page" in AGENTS.md.
 *
 * The About page's sample is answered from a file, so it skips all of this.
 */
export function PollPage() {
  const { session, anonymous } = useAuth()
  const { pollId: param } = useParams<{ pollId: string }>()
  const pollId = param && pollIdFromParam(param)
  const location = useLocation()
  // Held with the id it was made for. Never re-decided on a live signal: a
  // poll's mode and this reader's access can't change while they read it.
  const [read, setRead] = useState<{ pollId: string; page: PollRead } | null>(null)
  const [failed, setFailed] = useState<{ pollId: string; message: string } | null>(null)
  // A poll deleted while open here, as its topic's `poll_deleted` said.
  const [gone, setGone] = useState<string | null>(null)

  // A heading flying in from the list. Looked for while rendering (a card
  // press launches before navigating) and again in a mount layout effect (the
  // browser's forward button launches as the list unmounts, after this renders).
  const [flight, setFlight] = useState(() => (pollId ? peekFlight('poll', pollId) : null))
  const [phase, setPhase] = useState<'flying' | 'landing' | 'still'>(flight ? 'flying' : 'still')
  const flying = useRef<FlightRun | null>(null)
  useLayoutEffect(() => {
    if (flight || !pollId) return
    const late = peekFlight('poll', pollId)
    if (!late) return
    setFlight(late)
    setPhase('flying')
    // On arrival only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const skeletonSince = useRef<number | null>(null)

  const sample = !!pollId && isSampleId(pollId)
  // The read in hand, if it covers this address (a read of any question
  // describes the whole group).
  const covering =
    read && pollId && (read.pollId === pollId || questionsCovered(read.page).includes(pollId))
      ? read.page
      : null
  // Whether that read is of this exact question, and so can be handed down.
  const exact = read?.pollId === pollId
  const error = failed && failed.pollId === pollId ? failed.message : null

  // The page's own signal handler, registered once it mounts. Until then a
  // signal is the read that opens the poll. A ref, so registering doesn't
  // re-render and re-subscribe.
  const pageSignal = useRef<null | (() => boolean | void | Promise<boolean | void>)>(null)
  const watch = useCallback(
    (onPageSignal: (() => boolean | void | Promise<boolean | void>) | null) => {
      pageSignal.current = onPageSignal
    },
    [],
  )

  // Reads held for the questions around the one on screen, by question.
  const [ahead, setAhead] = useState<Record<string, PollRead>>({})

  const arrive = useCallback(async () => {
    if (!pollId) return
    const { page, error: readError } = await readPollPage(pollId)
    if (!page) {
      // Reported as a failed read so the hook retries.
      setFailed({ pollId, message: readError ?? 'Poll not found.' })
      return false
    }
    // Refused while signed out: they may be on the invite list, so remember
    // where they were headed for after sign-in. Written before anything can
    // navigate away.
    if (page.kind === 'unreadable' && (!session || anonymous))
      rememberDestination(location.pathname)
    await preloadCards(page)
    const since = skeletonSince.current
    const rest = since === null ? 0 : SKELETON_MIN_MS - (performance.now() - since)
    if (rest > 0) await new Promise((resolve) => setTimeout(resolve, rest))
    setFailed(null)
    setRead({ pollId, page })
    if (page.kind !== 'unreadable') setAhead((held) => ({ ...held, [pollId]: page }))
  }, [pollId, session, anonymous, location.pathname])

  const onSignal = useCallback(() => {
    const ask = pageSignal.current
    return ask ? ask() : arrive()
  }, [arrive])

  // Only the question on screen reports a deletion; see QuestionWatch.
  const onGone = useCallback(() => {
    if (pollId) setGone(pollId)
  }, [pollId])

  const aheadNow = useRef(ahead)
  aheadNow.current = ahead
  const onAhead = useCallback((id: string, page: PollRead) => {
    setAhead((held) => ({ ...held, [id]: page }))
    void preloadCards(page)
  }, [])
  // A question let go takes its held read with it; nothing keeps it current.
  const onDrop = useCallback((id: string) => {
    setAhead((held) => {
      if (!(id in held)) return held
      const rest = { ...held }
      delete rest[id]
      return rest
    })
  }, [])
  const hasAhead = useCallback((id: string) => id in aheadNow.current, [])

  // A stable `reread` that reaches whichever question is on screen.
  const currentReread = useRef<() => void>(() => {})
  const reread = useCallback(() => currentReread.current(), [])
  const report = useCallback((stream: LiveStream) => {
    currentReread.current = stream.reread
  }, [])

  const watched = !pollId
    ? []
    : sample
      ? [{ id: pollId, topic: null }]
      : questionsAround(covering, pollId).map((id) => ({ id, topic: pollTopic(id) }))
  const watchers = watched.map(({ id, topic }) => (
    <QuestionWatch
      key={id}
      id={id}
      topic={topic}
      current={id === pollId}
      onSignal={onSignal}
      onGone={onGone}
      onAhead={onAhead}
      onDrop={onDrop}
      hasAhead={hasAhead}
      report={report}
    />
  ))

  // Sample ballots and drafts last for this route's visit.
  useEffect(
    () => () => {
      forgetSampleBallots()
      forgetSampleDrafts()
    },
    [],
  )

  // A failure is remembered only while its address is on screen.
  useEffect(() => {
    setFailed(null)
  }, [pollId])

  const refused = covering?.kind === 'unreadable'

  // The list card the way back lands on: the group's first question.
  const listRow = (covering && firstQuestionOf(covering)) || pollId
  const leaving = useRef({ listRow, userId: session?.user.id })
  leaving.current = { listRow, userId: session?.user.id }

  // Leaving for the list by the browser's back button still flies the heading
  // back to its card; measured while the heading is still in the document.
  useLayoutEffect(() => {
    const now = leaving
    return () => {
      const { listRow, userId } = now.current
      if (listRow && onTheList() && readListSnapshot(userId))
        departing('list', listRow, headingIn(document, 'page'))
    }
  }, [])

  // The flight in, before first paint, from the top of the page.
  useLayoutEffect(() => {
    if (!flight) return
    landFlight(flight)
    window.scrollTo(0, 0)
    const target = headingIn(document, 'page')
    if (target) stillEntrances(target)
    if (!target) {
      setPhase('still')
      return
    }
    const run = fly(flight, target)
    flying.current = run
    let live = true
    void run.arrived.then(() => {
      if (live) setPhase('landing')
    })
    return () => {
      live = false
      run.cancel()
      flying.current = null
    }
  }, [flight])

  // Landed: what arrived underneath fades in, then the copy hands over.
  useLayoutEffect(() => {
    if (phase !== 'landing') return
    let live = true
    const done = flying.current
      ? flying.current.settle(headingIn(document, 'page'), motionMs('base'))
      : Promise.resolve()
    void done.then(() => {
      if (live) setPhase('still')
    })
    return () => {
      live = false
    }
  }, [phase])

  const waiting = !sample && gone !== pollId && !error && !covering && phase !== 'flying'
  useLayoutEffect(() => {
    if (!waiting) skeletonSince.current = null
    else skeletonSince.current ??= performance.now()
  }, [waiting])

  // Opening a poll clears its notifications (filed against the first question).
  useClearPollNotifications(
    pollId && !sample && covering && !refused ? [pollId, ...questionsCovered(covering)] : [],
  )

  const back = session ? (
    <Box maw={720} mx="auto">
      <BackToList listId={listRow} />
    </Box>
  ) : null

  // In flight: laid out (so the heading has a target) but hidden. Watchers
  // sit at the same place in the tree in both returns so landing doesn't
  // resubscribe.
  if (phase === 'flying')
    return (
      <>
        {watchers}
        <div style={{ visibility: 'hidden' }}>
          {back}
          <PollPageSkeleton
            title={carriedTitle(location.state)}
            heading={carriedHeading(location.state)}
            voted={carriedVoted(location.state)}
          />
        </div>
      </>
    )

  // No rise: the flown heading is already standing over it.
  return (
    <>
      {watchers}
      <Reveal enter={phase === 'landing'} rise={false}>
        {back}
        {page()}
      </Reveal>
    </>
  )

  function page() {
    if (sample) return <PublicPoll initial={null} watch={watch} reread={reread} />

    if (gone === pollId) return <PollDeleted signedIn={!!session} />

    if (error) {
      return (
        <Text role="alert" c="red" ta="center">
          {error}
        </Text>
      )
    }

    if (!covering)
      return (
        <PollPageSkeleton
          title={carriedTitle(location.state)}
          heading={carriedHeading(location.state)}
          voted={carriedVoted(location.state)}
        />
      )

    // Refused: to the sign-in screen (outside the shell). An anonymous session
    // has no email, so no invite poll will admit it either.
    if (refused && !session) return <Navigate to="/" replace />
    if (refused && anonymous) return <Navigate to="/sign-in" replace />

    // An open poll to an outsider, or a signed-in reader's "not found".
    if (covering.kind !== 'account')
      return (
        <PublicPoll
          initial={exact ? covering : null}
          watch={watch}
          reread={reread}
          prefetched={ahead[pollId ?? ''] ?? null}
        />
      )
    return (
      <PollDetail
        initial={exact ? covering : null}
        watch={watch}
        reread={reread}
        prefetched={ahead[pollId ?? ''] ?? null}
      />
    )
  }
}

/**
 * `id` and its neighbours, in strip order (so walking adds a watcher at one
 * end and drops one at the other without reordering).
 */
function questionsAround(page: PollRead | null, id: string): string[] {
  if (!page || page.kind === 'unreadable') return [id]
  const order = [...page.questions]
    .sort((a, b) => a.question_position - b.question_position)
    .map((question) => question.id)
  const at = order.indexOf(id)
  if (at < 0) return [id]
  return order.slice(Math.max(0, at - 1), at + 2)
}

/**
 * One question's live subscription; renders nothing. On screen, signals go to
 * the page's own handler. Beside it, they fetch a full `poll_page` into
 * `ahead`. The role is read at each signal, so a crossing never rebuilds the
 * channel. It also reads on becoming current with nothing held, and on
 * leaving if signals went to the page meanwhile (so walking back is current).
 */
function QuestionWatch({
  id,
  topic,
  current,
  onSignal,
  onGone,
  onAhead,
  onDrop,
  hasAhead,
  report,
}: {
  id: string
  /** Null for the sample. */
  topic: string | null
  current: boolean
  onSignal: () => boolean | void | Promise<boolean | void>
  onGone: () => void
  onAhead: (id: string, page: PollRead) => void
  onDrop: (id: string) => void
  hasAhead: (id: string) => boolean
  report: (stream: LiveStream) => void
}) {
  const role = useRef(current)
  const given = useRef({ onSignal, onGone, onAhead })
  useLayoutEffect(() => {
    role.current = current
    given.current = { onSignal, onGone, onAhead }
  })
  // Whether a signal went to the page since the held read was taken. The very
  // first read is the opening one, not an overtaking signal.
  const overtaken = useRef(false)
  const readOnce = useRef(false)

  const onChange = useCallback(async () => {
    const first = !readOnce.current
    readOnce.current = true
    if (role.current) {
      if (!first) overtaken.current = true
      return given.current.onSignal()
    }
    const { page } = await readPollPage(id)
    if (!page) return false
    overtaken.current = false
    given.current.onAhead(id, page)
    return true
  }, [id])
  // A group is deleted whole; only the question on screen says so.
  const onDeleted = useCallback(() => {
    if (role.current) given.current.onGone()
  }, [])
  const stream = useLiveStream(topic, onChange, onDeleted)

  useLayoutEffect(() => {
    if (current) report(stream)
  }, [current, stream, report])

  const was = useRef(current)
  useEffect(() => {
    if (was.current === current) return
    was.current = current
    if (current ? !hasAhead(id) : overtaken.current || !hasAhead(id)) stream.reread()
  }, [current, id, hasAhead, stream])

  useEffect(() => () => onDrop(id), [id, onDrop])

  return null
}

/*
 * What a list card hands its poll page in navigation state. Validated,
 * because history state can outlive the build that wrote it.
 */

function carriedTitle(state: unknown): string | undefined {
  const title = (state as { title?: unknown } | null)?.title
  return typeof title === 'string' && title ? title : undefined
}

function carriedHeading(state: unknown): PollHeadingProps | undefined {
  const heading = (state as { heading?: Partial<PollHeadingProps> } | null)?.heading
  return heading && typeof heading.title === 'string' && heading.state
    ? (heading as PollHeadingProps)
    : undefined
}

function carriedVoted(state: unknown): boolean {
  return (state as { voted?: unknown } | null)?.voted === true
}

/** The group's first question (the list's row for the poll), or undefined for a single question. */
function firstQuestionOf(page: PollRead): string | undefined {
  if (page.kind === 'unreadable' || page.questions.length === 0) return undefined
  return page.questions.reduce((a, b) => (b.question_position < a.question_position ? b : a)).id
}

/** Whether the address is the poll list itself (not the archived view, which has no cards to land on). */
function onTheList(): boolean {
  const path = window.location.hash.replace(/^#/, '')
  return path === '' || path === '/'
}

/** A poll deleted while open, as its topic said. */
function PollDeleted({ signedIn }: { signedIn: boolean }) {
  usePageTitle('Poll deleted')
  return (
    <Stack maw={720} mx="auto" gap="md" align="center">
      <Title order={1} size="h3">
        This poll has been deleted
      </Title>
      <Text c="dimmed" ta="center">
        Polls are automatically deleted after six months, or a poll can be deleted by its creator.
      </Text>
      {signedIn && (
        <Button
          component={Link}
          to="/"
          variant="light"
          leftSection={<ArrowLeftIcon size={16} aria-hidden />}
        >
          Back to your polls
        </Button>
      )}
    </Stack>
  )
}
