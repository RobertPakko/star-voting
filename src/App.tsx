import { useEffect } from 'react'
import { Center, Loader } from '@mantine/core'
import { Route, Routes, useNavigate, useParams } from 'react-router-dom'
import { useAuth } from './lib/auth'
import { takeDestination } from './lib/shareLink'
import { SignIn } from './pages/SignIn'
import { Layout } from './components/Layout'
import { PollList } from './pages/PollList'
import { CreatePoll } from './pages/CreatePoll'
import { PollDetail } from './pages/PollDetail'
import { PublicPoll } from './pages/PublicPoll'
import { About } from './pages/About'

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
            these two sit in front of the auth gate. */}
        <Route path="p/:token" element={<KeyedPublicPoll />} />
        <Route path="about" element={<About />} />

        {session && (
          <>
            <Route index element={<PollList />} />
            <Route path="polls/new" element={<CreatePoll />} />
            <Route path="polls/:pollId" element={<KeyedPollDetail />} />
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
 * Each question of a multi-question poll gets its own page, rather than one
 * page that changes which question it is about.
 *
 * A question is a poll of its own and lives at its own address, so moving
 * between them changes the route's *parameter* and not the route. Left to
 * itself React keeps the component mounted across that and hands it every
 * piece of state it was holding: the poll it had read, whether it had read
 * anything at all, a ballot half filled in. Until the next read came back the
 * question being left went on rendering under the address of the question
 * being opened — the previous question's options, or its "your vote is in",
 * beneath the next question's title.
 *
 * That was always true of the *Next* link in the question strip. It matters
 * more now that answering a question moves the voter on by itself, which
 * makes crossing between questions the ordinary way through a poll rather
 * than something a voter occasionally clicks.
 *
 * Keying on the parameter makes each question a fresh page, which is what it
 * is: the skeleton shows while the question loads, and nothing of the last
 * one survives into it.
 */
function KeyedPublicPoll() {
  const { token } = useParams<{ token: string }>()
  return <PublicPoll key={token} />
}

/** The same, for the signed-in side of a poll; see KeyedPublicPoll. */
function KeyedPollDetail() {
  const { pollId } = useParams<{ pollId: string }>()
  return <PollDetail key={pollId} />
}

export default App
