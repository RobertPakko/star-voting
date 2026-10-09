import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Box, Button, Center, Loader, Stack, Text, Title } from '@mantine/core'
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
import { questionsCovered, readPollPage } from './lib/pollPage'
import { pollTopic, useLiveStream } from './lib/useLiveStream'
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
} from './components/Skeletons'
import type { PollRead } from './lib/types'
import { pollIdFromParam } from './lib/pollId'
import { refreshAccountPush, useNotificationRoutes } from './lib/push'
import { useLaunchRoutes } from './lib/launch'
import { useClearPollNotifications } from './lib/badge'
import { usePageTitle } from './lib/pageTitle'
import { fly, landFlight, peekFlight, type FlightRun } from './lib/titleFlight'
import { motionMs } from './lib/motion'
import { BackToList } from './components/BackToList'
import { Reveal } from './components/Reveal'

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
 * not held at all. See lib/titleFlight.ts.
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

  // Opened from the list, with the poll's title flying in from its card: the
  // page starts blank under the title, is read while it flies, and arrives
  // once it lands — whole, if the read is back by then, and as its skeleton
  // if not. Taken once, on mount, like everything about how a page was
  // arrived at. See lib/titleFlight.ts.
  const [flight] = useState(() => (pollId ? peekFlight('poll', pollId) : null))
  const [phase, setPhase] = useState<'flying' | 'landing' | 'still'>(flight ? 'flying' : 'still')
  const flying = useRef<FlightRun | null>(null)
  // When the skeleton went up, while it is up; see SKELETON_MIN_MS.
  const skeletonSince = useRef<number | null>(null)
  // The card this poll was opened from, which is whether the page offers a way
  // back to the list and where on it that way lands. Held for as long as the
  // route is — every question of the poll included — because walking between
  // questions is a navigation of its own and does not carry the state along.
  const [listId] = useState(() => listIdOf(location.state))

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
  // question's and the page has its own reading to do: this is a route, not a
  // cache.
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
    // Back behind a skeleton that has only just gone up: left there long
    // enough not to flash; see SKELETON_MIN_MS.
    const since = skeletonSince.current
    const rest = since === null ? 0 : SKELETON_MIN_MS - (performance.now() - since)
    if (rest > 0) await new Promise((resolve) => setTimeout(resolve, rest))
    setFailed(null)
    setRead({ pollId, page })
  }, [pollId, session, anonymous, location.pathname])

  const onSignal = useCallback(() => {
    const ask = pageSignal.current
    return ask ? ask() : arrive()
  }, [arrive])

  // The one topic this route holds is the question on screen, so whatever
  // was deleted is this.
  const onGone = useCallback(() => {
    if (pollId) setGone(pollId)
  }, [pollId])

  // The route holds the subscription, and the poll's first read happens on
  // subscribing — the rule every other page follows. The topic is `poll:<id>`
  // and the id is in the URL, so there is nothing left to read the poll to
  // find out, and opening a poll costs one request instead of two.
  //
  // The sample watches nothing: it is answered out of a file in this browser,
  // so there is no topic and `PublicPoll` reads it for itself.
  const { status: liveStatus, reread } = useLiveStream(
    pollId && !sample ? pollTopic(pollId) : null,
    onSignal,
    onGone,
  )

  // A sample ballot lasts as long as the visit that cast it, and this route is
  // that visit: it stays mounted while a reader walks the sample's three
  // questions and on to the finished copy, and goes when they leave the poll
  // addresses altogether. See `SampleBallot` for why the sample forgets at all.
  useEffect(() => forgetSampleBallots, [])

  // A read that failed is remembered against the poll it failed for, so that
  // it is reported rather than retried on every render — but only for as long
  // as that address is on screen. Leaving and coming back is somebody asking
  // again, and a connection that dropped once should not make a poll
  // permanently unopenable for the life of the tab.
  useEffect(() => {
    setFailed(null)
  }, [pollId])

  const refused = covering?.kind === 'unreadable'

  // The title's flight in. Before the first paint, so the page is never seen
  // with the title already in place; and the page goes to its top first,
  // because the list may have been scrolled and the flight aims at the place
  // the title will be on screen.
  useLayoutEffect(() => {
    if (!flight) return
    landFlight(flight)
    window.scrollTo(0, 0)
    const target = document.querySelector('[data-title-landing]')
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
      ? flying.current.settle(document.querySelector('[data-title-landing]'), motionMs('base'))
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

  // The way back to the list, on a poll opened from it; see BackToList.
  const back =
    listId && session ? (
      <Box maw={720} mx="auto">
        <BackToList listId={listId} />
      </Box>
    ) : null

  // In the air: the page is laid out — so the title has somewhere to aim for
  // — and not shown. The skeleton is drawn because its title is drawn exactly
  // where the poll's will be; nothing else of it is seen.
  if (phase === 'flying')
    return (
      <div style={{ visibility: 'hidden' }}>
        {back}
        <PollPageSkeleton title={carriedTitle(location.state)} />
      </div>
    )

  // Faded in where it has landed, without the rise every other page arrives
  // with: the title is already standing in place over it, and a rise would
  // show as the real one sliding up under its copy.
  return (
    <Reveal enter={phase === 'landing'} rise={false}>
      {back}
      {page()}
    </Reveal>
  )

  function page() {
    // The sample, ahead of everything else: it is served from a file rather
    // than from the database, so the public reading is the only reading it has
    // — for a signed-in account as much as for a stranger's browser, since it
    // is nobody's poll and never was a row. It reads for itself, and a sample
    // id `samplePollData.ts` holds nothing for is a mistyped sample link, which
    // `PublicPoll` draws "poll not found" for.
    if (sample) return <PublicPoll initial={null} live={liveStatus} watch={watch} reread={reread} />

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
    if (!covering) return <PollPageSkeleton title={carriedTitle(location.state)} />

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
          live={liveStatus}
          watch={watch}
          reread={reread}
        />
      )
    return (
      <PollDetail
        initial={exact ? covering : null}
        live={liveStatus}
        watch={watch}
        reread={reread}
      />
    )
  }
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

/** The list card a poll was opened from, if it was; see BackToList. */
function listIdOf(state: unknown): string | undefined {
  const id = (state as { listId?: unknown } | null)?.listId
  return typeof id === 'string' && id ? id : undefined
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
        <Button component={Link} to="/" variant="light">
          Back to your polls
        </Button>
      )}
    </Stack>
  )
}

export default App
