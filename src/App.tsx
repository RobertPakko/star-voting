import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Box, Button, Center, Loader, Stack, Text, Title } from '@mantine/core'
import { ArrowLeftIcon } from '@phosphor-icons/react'
import {
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from 'react-router-dom'
import { useAuth } from './lib/auth'
import { forgetSampleBallots, isSampleId } from './lib/samplePoll'
import { forgetSampleDrafts } from './lib/ballotDraft'
import { questionsCovered, readPollPage } from './lib/pollPage'
import { pollTopic, useLiveStream, type LiveStream } from './lib/useLiveStream'
import { rememberDestination, takeDestination } from './lib/shareLink'
import { SignIn } from './pages/SignIn'
import { Layout } from './components/Layout'
import { PollList } from './pages/PollList'
import { PollDetail } from './pages/PollDetail'
import { PublicPoll } from './pages/PublicPoll'
import { NotFound } from './pages/NotFound'
import {
  AboutSkeleton,
  FormSkeleton,
  GuideSkeleton,
  PollPageSkeleton,
  SettingsSkeleton,
  DonateSkeleton,
} from './components/Skeletons'
import type { PollRead } from './lib/types'
import { pollIdFromParam } from './lib/pollId'
import { refreshAccountPush, useNotificationRoutes } from './lib/push'
import { useLaunchRoutes } from './lib/launch'
import { useClearPollNotifications } from './lib/badge'
import { usePageTitle } from './lib/pageTitle'
import {
  departing,
  fly,
  headingIn,
  landFlight,
  peekFlight,
  stillEntrances,
  type FlightRun,
} from './lib/headingFlight'
import { readListSnapshot } from './lib/listCache'
import type { PollHeadingProps } from './components/PollHeading'
import { motionMs } from './lib/motion'
import { BackToList } from './components/BackToList'
import { Reveal } from './components/Reveal'
import { preloadCards } from './components/deferred'

/**
 * The least time a poll page's skeleton is on screen once it is up.
 *
 * A skeleton that is replaced a few frames after it appeared is not a wait
 * the reader sees — it is a flicker, the page blinking between two shapes.
 * So once the shape has been drawn, the poll waits behind it at least this
 * long even when the read is already back: a moment's wait reads as the page
 * loading, where a flash reads as the page breaking. A read that is back
 * before the skeleton was ever drawn — which is the usual case for a poll
 * opened from the list, whose title flight is long enough to cover it — is
 * not held at all. See lib/headingFlight.ts.
 */
const SKELETON_MIN_MS = 400

/**
 * The two routes nobody is on when the app first paints, fetched when they
 * are asked for rather than with everything else.
 *
 * The split is drawn where the reader's own path is: a voter opening a share
 * link needs a ballot, and used to download the create form's tab strip, tag
 * input and segmented controls, and the whole of the About page, before they
 * could score anything. Neither is reachable from a poll page, so neither can
 * be needed in the same breath as one.
 *
 * The poll pages themselves are not split, and deliberately: they *are* the
 * first paint for the reader this app is least able to ask anything of.
 * `samplePollData` is split too, by an `import()` in lib/samplePoll.ts, for
 * the same reason one step further out.
 *
 * Each waits behind the shape of the page it is fetching, like every other
 * wait in the app — see Skeletons.tsx. A spinner here would be the one place
 * in the app that has a spinner and a known shape at the same time.
 */
const CreatePoll = lazy(() => import('./pages/CreatePoll').then((m) => ({ default: m.CreatePoll })))
const About = lazy(() => import('./pages/About').then((m) => ({ default: m.About })))
const Settings = lazy(() => import('./pages/Settings').then((m) => ({ default: m.Settings })))
const InstallGuide = lazy(() =>
  import('./pages/InstallGuide').then((m) => ({ default: m.InstallGuide })),
)
const Donate = lazy(() => import('./pages/Donate').then((m) => ({ default: m.Donate })))
const Intro = lazy(() => import('./pages/Intro').then((m) => ({ default: m.Intro })))

function App() {
  const { session, anonymous, loading } = useAuth()
  const navigate = useNavigate()

  // The magic-link redirect lands on the app root with no hash, so an
  // invitee who followed a share link would otherwise be dumped on the poll
  // list after signing in. SignIn stashes where they were headed.
  //
  // Only an account's session takes it. A session made without an account is
  // not the end of a sign-in, and the place stashed is usually one only an
  // account can open — an invite poll — so it is left for the sign-in that
  // follows rather than spent on a page that would turn the reader away.
  useEffect(() => {
    if (!session || anonymous) return
    const destination = takeDestination()
    if (destination) navigate(destination, { replace: true })
  }, [session, anonymous, navigate])

  // A tapped notification, arriving in a window that was already open.
  useNotificationRoutes()
  // The installed app opened again while it was open: its icon, a shortcut,
  // a captured link. See lib/launch.ts.
  useLaunchRoutes()

  // A device bound to this account for push is re-saved whenever the app
  // opens under it, which is what keeps a rotated endpoint from going quiet.
  // Asks for nothing; see lib/push.ts.
  const userId = session?.user.id
  useEffect(() => {
    if (userId) void refreshAccountPush(userId)
  }, [userId])

  if (loading) {
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    )
  }

  return (
    <Routes>
      {/* The intro film, for everybody, and outside the shell: it draws the
          app's header itself, and a real one above it would be the header
          twice. Its wait is the film's background and nothing else -- there
          is no page shape to stand in for a film. */}
      <Route
        path="intro"
        element={
          <Suspense
            fallback={<div style={{ position: 'fixed', inset: 0, background: '#f8f9fa' }} />}
          >
            <Intro />
          </Suspense>
        }
      />

      {/* Everything but the sign-in screen shares the app shell, so a
          signed-out voter and the poll's creator see the same header. */}
      <Route element={<Layout />}>
        {/* Open polls are votable without an account, and explaining the
            method is most useful to someone who has never signed in, so
            these two sit in front of the auth gate.

            A poll has one address whoever is reading it, which is the whole
            point of its link being its id: `PollPage` decides which of the
            two readings of it to render, rather than the URL deciding. */}
        <Route path="polls/:pollId" element={<PollPage />} />
        <Route
          path="about"
          element={
            <Suspense fallback={<AboutSkeleton />}>
              <About />
            </Suspense>
          }
        />
        {/* How to install the app and turn notifications on. In front of the
            gate for the same reason as About: the reader who most needs it
            arrived on a share link and has no account. */}
        <Route
          path="app"
          element={
            <Suspense fallback={<GuideSkeleton />}>
              <InstallGuide />
            </Suspense>
          }
        />

        {/* The page asking for a donation to charity. In front of the gate for
            the same reason as About: the site is free to everybody, and so is
            saying thanks for it. */}
        <Route
          path="donate"
          element={
            <Suspense fallback={<DonateSkeleton />}>
              <Donate />
            </Suspense>
          }
        />

        {/* A session made without an account has a poll list and makes
            polls exactly as an account does; see "Polls made without an
            account" in AGENTS.md. What it lacks is an address, which is
            what the create form and the header ask it about. */}
        {session && (
          <>
            <Route index element={<PollList />} />
            <Route
              path="polls/new"
              element={
                <Suspense fallback={<FormSkeleton />}>
                  <CreatePoll />
                </Suspense>
              }
            />
            {/* The email settings belong to an account, and the one thing
                that links here is the footer of an email -- which was sent to
                an account, not to whoever is signed in here without one. */}
            <Route
              path="settings"
              element={
                anonymous ? (
                  <Navigate to="/sign-in" replace state={{ from: '/settings' }} />
                ) : (
                  <Suspense fallback={<SettingsSkeleton />}>
                    <Settings />
                  </Suspense>
                )
              }
            />
            {/* An account has no sign-in screen to be on. This is where a
                code redeemed on that screen leaves the reader, the moment the
                session it mints takes the route away, and the destination
                effect above moves them on from here. */}
            {!anonymous && <Route path="sign-in" element={<Navigate to="/" replace />} />}
            {/* Anything else, for a reader who has an account: a mistyped
                address used to render the shell with an empty body. Signed
                out this is unreachable, and deliberately -- the catch-all
                below is the sign-in screen, which is where somebody with no
                session and no valid address should land anyway. */}
            <Route path="*" element={<NotFound />} />
          </>
        )}
      </Route>

      {/* Its own full-page card, with no shell around it: there is nothing
          to sign out of and nowhere else to go. Signed out it is every address
          the routes above do not claim; signed in without an account it has
          an address of its own, which the header's Sign in links to, because
          that reader's `/` is their poll list. */}
      {!session && <Route path="*" element={<SignIn />} />}
      {/* Named, because otherwise it is a poll: signed out, `polls/:pollId`
          above would take it and ask the database for a poll called "new".
          The sign-in screen at this address sends the reader on to the create
          form whichever way they get in -- see SignIn. The intro's "Make your
          own poll" is what links here. */}
      {!session && <Route path="polls/new" element={<SignIn />} />}
      {anonymous && <Route path="sign-in" element={<SignIn />} />}
    </Routes>
  )
}

/**
 * A poll, as whoever is looking at it can see it.
 *
 * One address serves both readings, because a poll has one address: a
 * signed-in participant gets `PollDetail`, which reads the poll as an account
 * and carries the creator's controls, and everybody else gets `PublicPoll`,
 * which reads it through the anon RPCs and can therefore only ever show an
 * open one.
 *
 * **The read that decides is the read that draws the page.** `poll_page`
 * answers both at once — which reading this reader is entitled to, and the
 * whole of it — so the route never finds out by trying. It used to, and the
 * trying was not free: a signed-in stranger holding an open poll's link paid
 * four queries answered with nothing, a discarded render, and then the public
 * reading starting from the beginning. See lib/pollPage.ts.
 *
 * **The answer does not change who can see what.** `poll_page` calls the same
 * functions this page used to call one at a time, and an invite poll somebody
 * is not in comes back tagged exactly as a poll that does not exist — so the
 * read cannot be used to find out which polls are real.
 *
 * **A crossing is not an arrival.** Every question answers with its whole
 * group, so the read that opened one already describes its siblings: walking
 * between them re-decides nothing and keeps the same page mounted, which is
 * what stops the heading and the strip blinking on the way.
 *
 * **The About page's sample skips all of this.** Its ids are words rather than
 * uuids and it is answered out of a file, so there is no row for the account
 * reading to find — `PollDetail` asking the `polls` table about `sample-host`
 * got back Postgres complaining that it is not a uuid. See `isSampleId`.
 */
function PollPage() {
  const { session, anonymous } = useAuth()
  const { pollId: param } = useParams<{ pollId: string }>()
  // The address is spelled short and the app is spelled canonical; this is
  // one of the three places the two meet. See lib/pollId.ts.
  const pollId = param && pollIdFromParam(param)
  const location = useLocation()
  // The read that decides everything below, held as the poll it was made for
  // rather than as a bare answer: what the last address turned out to be says
  // nothing about this one, and a stale answer would send a creator to the
  // public reading of their own poll.
  //
  // Nothing re-decides this on a live signal. Which page an address is cannot
  // change under a reader: a poll does not change mode, and nobody is added to
  // an invite list they are already reading. What moves is inside the poll,
  // and the page drawing it is what asks again — see `onSignal`.
  const [read, setRead] = useState<{ pollId: string; page: PollRead } | null>(null)
  const [failed, setFailed] = useState<{ pollId: string; message: string } | null>(null)
  // The poll that was deleted while it was open here, if it was. Told rather
  // than found out: its topic says `poll_deleted`, and asking the poll again
  // would only be refused. See `onGone` in useLiveStream.
  const [gone, setGone] = useState<string | null>(null)

  // Opened from the list, with the poll's heading flying in from its card: the
  // page starts blank under the heading, is read while it flies, and arrives
  // once it lands — whole, if the read is back by then, and as its skeleton
  // if not. See lib/headingFlight.ts.
  //
  // Looked for twice. A press on a card launches its flight before the
  // address moves, so it is there as this first renders; the browser's
  // forward button launches one as the list goes, which is after this has
  // rendered, so the mount's layout effect looks again — before the first
  // paint, so the page is never seen arriving the ordinary way first.
  const [flight, setFlight] = useState(() => (pollId ? peekFlight('poll', pollId) : null))
  const [phase, setPhase] = useState<'flying' | 'landing' | 'still'>(flight ? 'flying' : 'still')
  const flying = useRef<FlightRun | null>(null)
  useLayoutEffect(() => {
    if (flight || !pollId) return
    const late = peekFlight('poll', pollId)
    if (!late) return
    setFlight(late)
    setPhase('flying')
    // Once, on arrival: a flight is how a page is arrived at, not something
    // that happens to it later.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // When the skeleton went up, while it is up; see SKELETON_MIN_MS.
  const skeletonSince = useRef<number | null>(null)

  const sample = !!pollId && isSampleId(pollId)
  // The read in hand, if it describes the address being rendered. A read of
  // any question of a poll describes every question of it, which is what
  // makes walking through a poll cost nothing and stops this deciding the
  // same thing again at each one.
  const covering =
    read && pollId && (read.pollId === pollId || questionsCovered(read.page).includes(pollId))
      ? read.page
      : null
  // Whether the read that is in hand is about the question being opened, which
  // is what decides whether it is handed on. On a crossing it is the last
  // question's, and what the page draws is the read held for the question
  // being opened — see `ahead` below — or its own.
  const exact = read?.pollId === pollId
  const error = failed && failed.pollId === pollId ? failed.message : null

  // What the page on screen does with a signal, handed up by whichever page
  // that is and called in place of the read below once there is one.
  //
  // Null while there is no page — which is exactly while this route has not
  // read yet — and that is the whole mechanism: the first signal is the read
  // that opens the poll, and every one after it belongs to the page the read
  // chose. A ref rather than state because it is not something this renders
  // from, and because a page registering itself must not cause a render that
  // re-subscribes the channel it just registered against.
  const pageSignal = useRef<null | (() => boolean | void | Promise<boolean | void>)>(null)
  const watch = useCallback(
    (onPageSignal: (() => boolean | void | Promise<boolean | void>) | null) => {
      pageSignal.current = onPageSignal
    },
    [],
  )

  // The reads held for the questions beside the one on screen, by question;
  // see the watchers below. The one the poll was arrived at is held too, from
  // the read that opened it, so stepping off it and back costs nothing.
  const [ahead, setAhead] = useState<Record<string, PollRead>>({})

  // The read that opens the address: what may this reader see here, and the
  // whole of it. `poll_page` answers both at once — see lib/pollPage.ts.
  const arrive = useCallback(async () => {
    if (!pollId) return
    const { page, error: readError } = await readPollPage(pollId)
    if (!page) {
      // Reported, and reported as a read that did not work, so the hook tries
      // again shortly. A poll that is genuinely not there answers the same way
      // every time and the reader keeps the message; a request that lost a
      // race with a flaky connection gets another go, where it used to leave
      // the address dead for the life of the tab.
      setFailed({ pollId, message: readError ?? 'Poll not found.' })
      return false
    }
    // Refused: no such poll, or an invite poll this reader is not on the
    // list for, and deliberately not told which. A signed-out reader may
    // well be on that list — every invitation email links to exactly this
    // address — so where they were headed is stashed for the magic link to
    // bring them back to, and the sign-in screen below is what they get
    // instead of a dead end. Stashed here rather than in an effect watching
    // the answer, so it is written before anything can navigate away from
    // the address being written down.
    if (page.kind === 'unreadable' && (!session || anonymous))
      rememberDestination(location.pathname)
    // And the code for the cards it will draw, while the skeleton is still up
    // anyway: a finished poll's tally is a chunk of its own, and fetched after
    // the page arrived it was a second skeleton under the heading for as long
    // as that took. See `preloadCards`.
    await preloadCards(page)
    // Back behind a skeleton that has only just gone up: left there long
    // enough not to flash; see SKELETON_MIN_MS.
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

  // Only the question on screen reports a deletion, so whatever was deleted is
  // this. (The neighbours hear it too — a group is deleted whole — and say
  // nothing; see QuestionWatch.)
  const onGone = useCallback(() => {
    if (pollId) setGone(pollId)
  }, [pollId])

  // The route holds the subscriptions, and a question's first read happens on
  // subscribing — the rule every other page follows. The topic is `poll:<id>`
  // and the id is in the URL, so there is nothing left to read the poll to
  // find out, and opening a poll costs one request instead of two.
  //
  // **And the questions either side of it are held as well**, subscribed and
  // read, so that the step a reader is most likely to take next — Next,
  // Previous, or being carried on by a ballot — lands on a question that is
  // already in hand rather than one the page has to go and fetch. Same rule
  // for each of them: subscribe, read on subscribing, read again on a signal.
  // What a neighbour's reads bring back is kept in `ahead` and handed to the
  // page the moment that question is opened, which draws it before the
  // browser paints, so no skeleton is ever seen for it.
  //
  // **A crossing hands the subscription over rather than opening another.**
  // Each question's topic is held by one `QuestionWatch`, keyed by the
  // question, so moving from question 2 to question 3 keeps 3's channel — it
  // only changes which of them is the one on screen — and opens 4's. The
  // Supabase client shares a channel between everything asking for one topic,
  // so two owners could not have held it anyway; and nothing has to be read
  // again on arrival, because the channel has been carrying 3's signals all
  // along and every one of them was read.
  //
  // The sample watches nothing: it is answered out of a file in this browser,
  // so there is no topic and `PublicPoll` reads it for itself.
  const aheadNow = useRef(ahead)
  aheadNow.current = ahead
  const onAhead = useCallback((id: string, page: PollRead) => {
    setAhead((held) => ({ ...held, [id]: page }))
    // So a step to it draws its cards at once, as it draws the rest of it.
    void preloadCards(page)
  }, [])
  // A question let go takes its read with it: nothing keeps it current any
  // more, and a read nothing keeps current is not one to draw a page from.
  const onDrop = useCallback((id: string) => {
    setAhead((held) => {
      if (!(id in held)) return held
      const rest = { ...held }
      delete rest[id]
      return rest
    })
  }, [])
  const hasAhead = useCallback((id: string) => id in aheadNow.current, [])

  // What the question on screen reports up: the way into its funnel, which the
  // page's own reads go through. `reread` keeps one identity for the life of the route, as the
  // single stream's did, and reaches whichever question is on screen.
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

  // A sample ballot lasts as long as the visit that cast it, and this route is
  // that visit: it stays mounted while a reader walks the sample's three
  // questions and on to the finished copy, and goes when they leave the poll
  // addresses altogether. See `SampleBallot` for why the sample forgets at all.
  // Its unsent ballots go with the sent ones (lib/ballotDraft.ts).
  useEffect(
    () => () => {
      forgetSampleBallots()
      forgetSampleDrafts()
    },
    [],
  )

  // A read that failed is remembered against the poll it failed for, so that
  // it is reported rather than retried on every render — but only for as long
  // as that address is on screen. Leaving and coming back is somebody asking
  // again, and a connection that dropped once should not make a poll
  // permanently unopenable for the life of the tab.
  useEffect(() => {
    setFailed(null)
  }, [pollId])

  const refused = covering?.kind === 'unreadable'

  // This poll's card on the list, which is where the way back lands: the
  // group's first question, which is the row the list draws for the whole
  // poll, whichever question is open. Until the poll is read, the question
  // being opened — which is that row whenever the poll was opened from it.
  const listRow = (covering && firstQuestionOf(covering)) || pollId
  const leaving = useRef({ listRow, userId: session?.user.id })
  leaving.current = { listRow, userId: session?.user.id }

  // Going back to the list some way other than the page's own control — the
  // browser's back button, most of all — flies the heading back onto its card
  // just the same, where the list will be drawn as it was left. Measured as
  // the page goes, while the heading is still on it; see `departing`.
  useLayoutEffect(() => {
    const now = leaving
    return () => {
      const { listRow, userId } = now.current
      if (listRow && onTheList() && readListSnapshot(userId))
        departing('list', listRow, headingIn(document, 'page'))
    }
  }, [])

  // The title's flight in. Before the first paint, so the page is never seen
  // with the title already in place; and the page goes to its top first,
  // because the list may have been scrolled and the flight aims at the place
  // the title will be on screen.
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

  // Landed: whatever has arrived underneath — the poll, or its skeleton —
  // fades in beneath the title, which then hands over to the real one.
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

  // Whether the skeleton is what is on screen, which starts its clock.
  const waiting = !sample && gone !== pollId && !error && !covering && phase !== 'flying'
  useLayoutEffect(() => {
    if (!waiting) skeletonSince.current = null
    else skeletonSince.current ??= performance.now()
  }, [waiting])

  // Opening a poll is reading its news: its notifications go from the tray
  // and from the count on the installed app's icon. Every question of the
  // group, since the notifications are filed against the first. Not for a
  // poll this reader may not see, which they have no notification about.
  useClearPollNotifications(
    pollId && !sample && covering && !refused ? [pollId, ...questionsCovered(covering)] : [],
  )

  // The way back to the list, for everybody who has one; see BackToList.
  const back = session ? (
    <Box maw={720} mx="auto">
      <BackToList listId={listRow} />
    </Box>
  ) : null

  // In the air: the page is laid out — so the title has somewhere to aim for
  // — and not shown. The skeleton is drawn because its title is drawn exactly
  // where the poll's will be; nothing else of it is seen.
  //
  // The watchers stand in front of either, at one place in the tree, so the
  // flight landing does not take every subscription down and up again.
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

  // Faded in where it has landed, without the rise every other page arrives
  // with: the title is already standing in place over it, and a rise would
  // show as the real one sliding up under its copy.
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
    // The sample, ahead of everything else: it is served from a file rather
    // than from the database, so the public reading is the only reading it has
    // — for a signed-in account as much as for a stranger's browser, since it
    // is nobody's poll and never was a row. It reads for itself, and a sample
    // id `samplePollData.ts` holds nothing for is a mistyped sample link, which
    // `PublicPoll` draws "poll not found" for.
    if (sample) return <PublicPoll initial={null} watch={watch} reread={reread} />

    // Ahead of whatever was on screen, ballot and all: a vote cast on it now
    // would only be refused, with nothing to say why.
    if (gone === pollId) return <PollDeleted signedIn={!!session} />

    if (error) {
      return (
        <Text role="alert" c="red" ta="center">
          {error}
        </Text>
      )
    }

    // Nothing decided yet. The shape of the page that is coming, which is what
    // both readings draw while they load, so waiting here rather than inside
    // one of them looks like nothing at all.
    if (!covering)
      return (
        <PollPageSkeleton
          title={carriedTitle(location.state)}
          heading={carriedHeading(location.state)}
          voted={carriedVoted(location.state)}
        />
      )

    // The sign-in screen is deliberately outside the app shell, which is what
    // the redirect is for: the catch-all route below renders it bare. A session
    // made without an account is offered it too, at its own address: it has no
    // email, so no invite poll will ever admit it, and this one may well be
    // addressed to the account it has not signed in to yet.
    if (refused && !session) return <Navigate to="/" replace />
    if (refused && anonymous) return <Navigate to="/sign-in" replace />

    // An open poll to somebody outside it, and — to a signed-in reader who has
    // been refused — the card that says a link is not a link.
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
 * `id` and the questions either side of it in the poll `page` describes — the
 * ones a reader is likeliest to open next, and so the ones `PollPage` holds
 * ready — in the order the strip draws them. Just `id` for a poll of one
 * question or one this reader may not see.
 *
 * In the strip's order rather than with `id` first, so that walking along
 * only ever adds a watcher at one end and drops one at the other: none of
 * them changes place among the rest, and React has nothing to move.
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
 * One question's subscription, held for as long as the question is on screen
 * or beside it. It draws nothing.
 *
 * Every signal on its topic is read, which is the same rule a page follows;
 * what differs is where the read goes. **On screen**, it is the page's: the
 * signal is handed to whatever the page registered, which does the narrow
 * read it always did. **Beside the one on screen**, it reads the whole page —
 * `poll_page`, the read a poll is opened with — and hands that up, to be
 * drawn the moment the question is opened.
 *
 * Which of the two it is moves under it as the reader walks the poll, and is
 * read at the moment of each read rather than fixed when the subscription was
 * made, so the channel is never rebuilt for it. Two moments need a read the
 * channel would not otherwise make:
 *
 *  - **opened with nothing in hand**, because its read ahead has not come back
 *    yet, or did not work. The page reads, through the same funnel, as it
 *    would have on subscribing.
 *  - **left with what is in hand overtaken**, because while it was on screen
 *    its signals went to the page rather than into the read held for it. So
 *    walking back to it is drawn from a read that is current, not from the one
 *    taken before the reader got there. Left untouched, nothing is read.
 *
 * A read already in flight when the question changes role lands where the new
 * role says, and because each question's reads go through one funnel they land
 * in order: a read ahead that is still out when the reader arrives is drawn
 * when it lands, and nothing the page asks for afterwards can overtake it.
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
  /** Null for the sample, which nothing is ever said about. */
  topic: string | null
  /** Whether this is the question on screen. */
  current: boolean
  /** The page's own answer to a signal, while this is on screen. */
  onSignal: () => boolean | void | Promise<boolean | void>
  /** The page's answer to the poll being deleted, while this is on screen. */
  onGone: () => void
  /** Where a read made ahead goes. */
  onAhead: (id: string, page: PollRead) => void
  /** Called as the question is let go, so its read can go with it. */
  onDrop: (id: string) => void
  /** Whether a read made ahead is in hand for it. */
  hasAhead: (id: string) => boolean
  /** Where the question on screen reports its status and its funnel. */
  report: (stream: LiveStream) => void
}) {
  const role = useRef(current)
  const given = useRef({ onSignal, onGone, onAhead })
  useLayoutEffect(() => {
    role.current = current
    given.current = { onSignal, onGone, onAhead }
  })
  // Whether a signal reached the page rather than the read held ahead, since
  // that read was taken; see above. The first read a question makes is the one
  // that opens it, not a signal overtaking anything: on the question the poll
  // was arrived at it is the route's own `poll_page`, which is held for it.
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
  // A group is deleted whole, so every question held hears it; only the one on
  // screen says so, and the rest stand down rather than reading a poll that
  // has gone.
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

/**
 * The title a poll's card on the list hands its page on the way in, so the
 * page can name the poll before it has read it. A title cannot change after
 * the poll is made, so this is never a guess; anything that is not a string is
 * an address arrived at some other way, and the page waits for its read.
 */
function carriedTitle(state: unknown): string | undefined {
  const title = (state as { title?: unknown } | null)?.title
  return typeof title === 'string' && title ? title : undefined
}

/**
 * The whole heading a poll's card on the list hands its page, so the page can
 * draw it before it has read the poll — and so the card's heading has
 * somewhere to fly to. See `PollPageSkeleton`. Checked for the two fields the
 * heading cannot be drawn without, since a navigation's state outlives the
 * build that wrote it: an address reopened from history after a deploy may
 * carry an older shape, and then the page waits for its read as it would have
 * anyway.
 */
function carriedHeading(state: unknown): PollHeadingProps | undefined {
  const heading = (state as { heading?: Partial<PollHeadingProps> } | null)?.heading
  return heading && typeof heading.title === 'string' && heading.state
    ? (heading as PollHeadingProps)
    : undefined
}

/**
 * Whether the card on the list said this reader had voted in the poll, which
 * decides between the ballot and *your vote is in* in the shape the page waits
 * behind. Anything but `true` is the ballot, which is what it always drew.
 */
function carriedVoted(state: unknown): boolean {
  return (state as { voted?: unknown } | null)?.voted === true
}

/**
 * The group's first question — the row the poll list draws for the whole poll
 * — or nothing, for a poll that asks one question and is its own row.
 */
function firstQuestionOf(page: PollRead): string | undefined {
  if (page.kind === 'unreadable' || page.questions.length === 0) return undefined
  return page.questions.reduce((a, b) => (b.question_position < a.question_position ? b : a)).id
}

/**
 * Whether the address has moved on to the poll list itself — not the removed
 * polls, which are the same route with a query on it and have no card for a
 * heading to land on.
 */
function onTheList(): boolean {
  const path = window.location.hash.replace(/^#/, '')
  return path === '' || path === '/'
}

/**
 * A poll that was deleted while somebody had it open.
 *
 * The same two things `NotFound` says — what happened, and that the reader is
 * not stuck — but in the past tense, because this one is known rather than
 * guessed at: the poll's own topic said so. The way out is the poll list, for
 * a reader who has one.
 */
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

export default App
