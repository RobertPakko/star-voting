import { useCallback, useEffect, useRef, useState } from 'react'
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
import { CreatePoll } from './pages/CreatePoll'
import { PollDetail } from './pages/PollDetail'
import { PublicPoll } from './pages/PublicPoll'
import { About } from './pages/About'
import { PollPageSkeleton } from './components/Skeletons'
import type { PollRead } from './lib/types'

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
        <Route path="about" element={<About />} />

        {session && (
          <>
            <Route index element={<PollList />} />
            <Route path="polls/new" element={<CreatePoll />} />
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
 * One address serves both readings, because a poll has one address: a signed
 * -in participant gets `PollDetail`, which reads the poll as an account and
 * carries the creator's controls, and everybody else gets `PublicPoll`, which
 * reads it through the anon RPCs and can therefore only ever show an open
 * one. There used to be a route each -- `#/polls/:id` for the first and
 * `#/p/:token` for the second -- and the split was the whole of what made an
 * open poll's creator unable to hand out the address in front of them.
 *
 * **The read that decides is the read that draws the page.** `poll_page`
 * answers both at once -- which reading this reader is entitled to, and the
 * whole of it -- so the route no longer has to find out by trying. See
 * lib/pollPage.ts and 0048_one_read_opens_a_poll.sql.
 *
 * It used to find out by trying, and the trying was not free. Every address
 * went to `PollDetail` first, on the reasoning that it read the `polls` row
 * as its first act anyway and row-level security answers exactly the question
 * being asked. That is true, and it is a good deal for the creator opening
 * their own poll. It is a bad one for a signed-in stranger holding an open
 * poll's link: four queries answered with nothing, a discarded render, and
 * then the public reading starting again from the beginning. Three round
 * trips to open a poll that was public the whole time. Asking one question
 * that has a real answer costs the creator nothing and costs the stranger two
 * of those trips.
 *
 * **What the answer does not change is who can see what.** `poll_page` calls
 * the same functions this page used to call one at a time, so every rule
 * about who may read a poll is where it always was; it grants nothing that
 * asking them separately would not have. And an invite poll somebody is not
 * in comes back tagged exactly as a poll that does not exist, so the read
 * cannot be used to find out which polls are real.
 *
 * **A crossing is not an arrival.** Every question of a multi-question poll
 * answers with the whole group, so the read that opened one question already
 * describes its siblings: walking between them re-decides nothing and keeps
 * the same page mounted, which is what stops the heading and the strip
 * blinking on the way. Only an address this read does not cover is an arrival
 * somewhere new, and only that waits.
 *
 * **The About page's sample poll is the one address that skips all of this.**
 * Its ids are words rather than uuids and it is answered out of a file in the
 * browser, so there is no row for the account reading to find and no sign-in
 * that could produce one: `PollDetail` asked the `polls` table about
 * `sample-host` and got back Postgres complaining that it is not a uuid,
 * which is what a signed-in reader saw where the sample should have been.
 * Under the two routes this replaced the question never came up, because
 * `#/p/:token` went to the public reading and nowhere else. See
 * `isSampleId` in lib/samplePoll.ts.
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
  // subscribing — the rule every other page in the app follows, which this one
  // could not while the read that chose the page was made before the page
  // existed to subscribe. The topic is `poll:<id>` and the id is in the URL,
  // exactly as the poll list's topic is its reader's id, so there is nothing
  // left to read the poll to find out.
  //
  // What that buys is one request to open a poll instead of two. The page used
  // to be read here and then, a moment later, read again by the page it chose
  // the instant its own subscription went live — not waste, but the price of
  // the window between the two, in which a vote could land unheard. Subscribing
  // first closes the window rather than paying for it.
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
