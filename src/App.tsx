import { useEffect } from 'react'
import { Center, Loader } from '@mantine/core'
import { Route, Routes, useNavigate } from 'react-router-dom'
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
        <Route path="p/:token" element={<PublicPoll />} />
        <Route path="about" element={<About />} />

        {session && (
          <>
            <Route index element={<PollList />} />
            <Route path="polls/new" element={<CreatePoll />} />
            <Route path="polls/:pollId" element={<PollDetail />} />
          </>
        )}
      </Route>

      {/* Its own full-page card, with no shell around it: there is nothing
          to sign out of and nowhere else to go. */}
      {!session && <Route path="*" element={<SignIn />} />}
    </Routes>
  )
}

export default App
