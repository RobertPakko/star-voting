import { lazy, Suspense, useEffect } from 'react'
import { Center, Loader } from '@mantine/core'
import { Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom'
import { useAuth } from './lib/auth'
import { takeDestination } from './lib/shareLink'
import { SignIn } from './pages/SignIn'
import { Layout } from './components/Layout'
import { PollList } from './pages/PollList'
import { PollPage } from './pages/PollPage'
import { NotFound } from './pages/NotFound'
import {
  AboutSkeleton,
  ContactSkeleton,
  DonateSkeleton,
  FormSkeleton,
  GuideSkeleton,
  SettingsSkeleton,
} from './components/Skeletons'
import { isPollParam, pollIdFromParam, pollPath } from './lib/pollId'
import { refreshAccountPush, useNotificationRoutes } from './lib/push'
import { useLaunchRoutes } from './lib/launch'

/*
 * Pages a voter on a share link never needs are split into their own chunks.
 * The poll pages are not: they are the first paint for the reader we can
 * least afford to keep waiting. Each waits behind its page's skeleton.
 */
const CreatePoll = lazy(() => import('./pages/CreatePoll').then((m) => ({ default: m.CreatePoll })))
const About = lazy(() => import('./pages/About').then((m) => ({ default: m.About })))
const Settings = lazy(() => import('./pages/Settings').then((m) => ({ default: m.Settings })))
const InstallGuide = lazy(() =>
  import('./pages/InstallGuide').then((m) => ({ default: m.InstallGuide })),
)
const Donate = lazy(() => import('./pages/Donate').then((m) => ({ default: m.Donate })))
const Contact = lazy(() => import('./pages/Contact').then((m) => ({ default: m.Contact })))
const Intro = lazy(() => import('./pages/Intro').then((m) => ({ default: m.Intro })))
const Start = lazy(() => import('./pages/Start').then((m) => ({ default: m.Start })))

function App() {
  const { session, anonymous, loading } = useAuth()
  const navigate = useNavigate()

  // The magic link lands on the root, so go where SignIn stashed. Only for a
  // real account: the stash is usually an invite poll an anonymous session
  // couldn't open anyway.
  useEffect(() => {
    if (!session || anonymous) return
    const destination = takeDestination()
    if (destination) navigate(destination, { replace: true })
  }, [session, anonymous, navigate])

  useNotificationRoutes()
  useLaunchRoutes()

  // Re-save this device's push binding on open, so a rotated endpoint is caught.
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
      {/* Outside the shell: the film draws its own header. */}
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

      {/* Outside the shell; nothing links to it. */}
      <Route
        path="start"
        element={
          <Suspense fallback={null}>
            <Start />
          </Suspense>
        }
      />

      <Route element={<Layout />}>
        {/* Public routes, in front of the auth gate. A poll's address is just
            its id; `PollRoute` turns away segments that aren't shaped like
            one. `#/polls/<id>` is the pre-rebrand address, still in old emails. */}
        <Route path=":pollId" element={<PollRoute />} />
        <Route path="polls/:pollId" element={<OldPollAddress />} />
        <Route
          path="about"
          element={
            <Suspense fallback={<AboutSkeleton />}>
              <About />
            </Suspense>
          }
        />
        <Route
          path="app"
          element={
            <Suspense fallback={<GuideSkeleton />}>
              <InstallGuide />
            </Suspense>
          }
        />
        <Route
          path="donate"
          element={
            <Suspense fallback={<DonateSkeleton />}>
              <Donate />
            </Suspense>
          }
        />
        <Route
          path="contact"
          element={
            <Suspense fallback={<ContactSkeleton />}>
              <Contact />
            </Suspense>
          }
        />

        {/* Any session, including one without an account. */}
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
            {/* Linked from email footers, which went to an account. */}
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
            {/* Where a code redeemed on the sign-in screen leaves an account. */}
            {!anonymous && <Route path="sign-in" element={<Navigate to="/" replace />} />}
            {/* Signed out, the catch-all is the sign-in screen instead. */}
            <Route path="*" element={<NotFound />} />
          </>
        )}
      </Route>

      {/* The sign-in screen, outside the shell. These one-segment names must
          be routes of their own, or `:pollId` / `polls/:pollId` would take them. */}
      {!session && <Route path="*" element={<SignIn />} />}
      {!session && <Route path="polls/new" element={<SignIn />} />}
      {(!session || anonymous) && <Route path="sign-in" element={<SignIn />} />}
      {!session && <Route path="settings" element={<SignIn />} />}
    </Routes>
  )
}

/** A poll if the segment is shaped like a poll id, otherwise not found. See `isPollParam`. */
function PollRoute() {
  const { pollId: param } = useParams<{ pollId: string }>()
  return param && isPollParam(param) ? <PollPage /> : <NotFound />
}

/** `#/polls/<id>`, the address every poll had until the rebrand. */
function OldPollAddress() {
  const { pollId: param = '' } = useParams<{ pollId: string }>()
  return <Navigate to={pollPath(pollIdFromParam(param))} replace />
}

export default App
