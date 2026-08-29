import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { Center, Loader, Text } from '@mantine/core'
import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom'
import { useAuth } from './lib/auth'
import { isSampleId } from './lib/samplePoll'
import { questionsCovered, readPollPage } from './lib/pollPage'
import { pollTopic, useLiveStream } from './lib/useLiveStream'
import { rememberDestination, takeDestination } from './lib/shareLink'
import { SignIn } from './pages/SignIn'
import { Layout } from './components/Layout'
import { PollList } from './pages/PollList'
import { PollDetail } from './pages/PollDetail'
import { PublicPoll } from './pages/PublicPoll'
import { AboutSkeleton, FormSkeleton, PollPageSkeleton } from './components/Skeletons'
import type { PollRead } from './lib/types'

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

function App() {
  const { session, loading } = useAuth()
  const navigate = useNavigate()

  // The magic-link redirect lands on the app root with no hash, so an
  // invitee who followed a share link would otherwise be dumped on the poll
  // list after signing in. SignIn stashes where they were headed.
  useEffect(() => {
    if (!session) return
    const destination = takeDestination()
    if (destination) navigate(destination, { replace: true })
  }, [session, navigate])

  if (loading) {
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    )
  }

  return (
    <Routes>
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
          </>
        )}
      </Route>

      {/* Its own full-page card, with no shell around it: there is nothing
          to sign out of and nowhere else to go. */}
      {!session && <Route path="*" element={<SignIn />} />}
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
  const { session } = useAuth()
  const { pollId } = useParams<{ pollId: string }>()
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
    if (page.kind === 'unreadable' && !session) rememberDestination(location.pathname)
    setFailed(null)
    setRead({ pollId, page })
  }, [pollId, session, location.pathname])

  const onSignal = useCallback(() => {
    const ask = pageSignal.current
    return ask ? ask() : arrive()
  }, [arrive])

  // The route holds the subscription, and the poll's first read happens on
  // subscribing — the rule every other page follows. The topic is `poll:<id>`
  // and the id is in the URL, so there is nothing left to read the poll to
  // find out, and opening a poll costs one request instead of two.
  //
  // The sample watches nothing: it is answered out of a file in this browser,
  // so there is no topic and `PublicPoll` reads it for itself.
  const liveStatus = useLiveStream(pollId && !sample ? [pollTopic(pollId)] : [], onSignal)

  // A read that failed is remembered against the poll it failed for, so that
  // it is reported rather than retried on every render — but only for as long
  // as that address is on screen. Leaving and coming back is somebody asking
  // again, and a connection that dropped once should not make a poll
  // permanently unopenable for the life of the tab.
  useEffect(() => {
    setFailed(null)
  }, [pollId])

  const refused = covering?.kind === 'unreadable'

  // The sample, ahead of everything else: it is served from a file rather
  // than from the database, so the public reading is the only reading it has
  // — for a signed-in account as much as for a stranger's browser, since it
  // is nobody's poll and never was a row. It reads for itself, and a sample
  // id `samplePollData.ts` holds nothing for is a mistyped sample link, which
  // `PublicPoll` draws "poll not found" for.
  if (sample) return <PublicPoll initial={null} live={liveStatus} watch={watch} />

  if (error) {
    return (
      <Text c="red" ta="center">
        {error}
      </Text>
    )
  }

  // Nothing decided yet. The shape of the page that is coming, which is what
  // both readings draw while they load, so waiting here rather than inside
  // one of them looks like nothing at all.
  if (!covering) return <PollPageSkeleton />

  // The sign-in screen is deliberately outside the app shell, which is what
  // the redirect is for: the catch-all route below renders it bare.
  if (refused && !session) return <Navigate to="/" replace />

  // An open poll to somebody outside it, and — to a signed-in reader who has
  // been refused — the card that says a link is not a link.
  if (covering.kind !== 'account')
    return <PublicPoll initial={exact ? covering : null} live={liveStatus} watch={watch} />
  return <PollDetail initial={exact ? covering : null} live={liveStatus} watch={watch} />
}

export default App
