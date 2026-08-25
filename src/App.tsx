import { useCallback, useEffect, useState } from 'react'
import { Center, Loader } from '@mantine/core'
import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom'
import { useAuth } from './lib/auth'
import { rememberDestination, takeDestination } from './lib/shareLink'
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
 * **The signed-in case decides for itself, rather than being asked about.**
 * `PollDetail` already reads the `polls` row as its first act, and row-level
 * security answers that question exactly: a row comes back for the creator
 * and for an invitee, and nothing comes back for anybody else. So it reports
 * "I cannot see this" instead of drawing "poll not found", and the fallback
 * costs one wasted read on a path almost nobody takes -- a signed-in stranger
 * following an open poll's link. Probing first would have cost every creator
 * opening their own poll an extra round trip to learn what the read they were
 * about to make already knew.
 *
 * A signed-out reader is not asked at all: there is no account for the RLS to
 * answer about, so the public reading is the only one available. If that
 * fails too -- an invite poll, or nothing at all -- `PublicPoll` says the link
 * is not one, and the sign-in route below is what a visitor gets for every
 * other address.
 */
function PollPage() {
  const { session } = useAuth()
  const { pollId } = useParams<{ pollId: string }>()
  const location = useLocation()
  // Both held as the poll they are about rather than as bare flags: whether
  // the last poll could be read says nothing about this one, and a stale
  // `true` would send a creator to the public reading of their own poll.
  const [unreadable, setUnreadable] = useState<string | null>(null)
  const [notPublic, setNotPublic] = useState<string | null>(null)

  // Stable across renders, because both pages take these into the dependency
  // list of the read they are about to make: a fresh closure every render
  // would be a fresh `load` every render, and something to re-read on.
  const accountFailed = useCallback(() => setUnreadable(pollId ?? null), [pollId])
  const publicFailed = useCallback(() => {
    if (!session) rememberDestination(location.pathname)
    setNotPublic(pollId ?? null)
  }, [session, location.pathname, pollId])

  // Signed out, and this is not a poll that can be read without an account:
  // it is invite-only, or it is nothing at all. The visitor may well be on
  // its invite list — every invitation email links to exactly this address —
  // so they are offered the sign-in screen rather than told their link is
  // dead. The sign-in screen is deliberately outside the app shell, which is
  // what the redirect is for: the catch-all route below renders it bare, and
  // where they were going has already been stashed.
  if (!session && notPublic === pollId) return <Navigate to="/" replace />

  if (!session || unreadable === pollId) return <PublicPoll onUnreadable={publicFailed} />
  return <PollDetail onUnreadable={accountFailed} />
}

export default App
