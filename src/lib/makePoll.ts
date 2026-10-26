import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from './auth'

/**
 * "Make your own poll" from a page anybody can reach — About, the intro, the
 * Start page — where the reader may well have no session.
 *
 * It reads the same to everybody, because anybody can make a poll: a reader
 * with no session is given one without an account on the press, as "Continue
 * without an account" on the sign-in screen does, and taken to the create
 * form. It used to send them to sign in first, which was a step the app no
 * longer needs.
 *
 * The form is only a route once there is a session, so the navigation waits
 * for the session to arrive rather than following the sign-in's promise:
 * `/new` without one is the sign-in screen.
 *
 * `start` is undefined for a reader who already has a session, whose press is
 * an ordinary link to the form.
 */
export function useMakePoll() {
  const { session, continueWithoutAccount } = useAuth()
  const navigate = useNavigate()
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (starting && session) navigate('/new')
  }, [starting, session, navigate])

  async function start() {
    setError(null)
    setStarting(true)
    try {
      await continueWithoutAccount()
    } catch (e) {
      setStarting(false)
      setError(e instanceof Error ? e.message : 'Could not start a poll. Try again.')
    }
  }

  return { start: session ? undefined : start, starting, error }
}
