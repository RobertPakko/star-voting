import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from './auth'
import type { Choice, Variant } from './choices'

/**
 * "Make your own poll" from a page anybody can reach — the home page, the
 * intro — where the reader may well have no session.
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
 * an ordinary link to the form. `to` is the form's address, which can carry
 * a choice or variant to start on (`tryPath`).
 */
export function useMakePoll(to = '/new') {
  const { session, continueWithoutAccount } = useAuth()
  const navigate = useNavigate()
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (starting && session) navigate(to)
  }, [starting, session, navigate, to])

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

/**
 * The create form, starting its first question on a choice or a variant:
 * *Try it out* on `/choices`, `/variants` and the choice guide. The form reads
 * both as a default (`startingQuestion` in lib/pollForm.ts), so a value it
 * does not know is ignored.
 */
export function tryPath({ choice, variant }: { choice?: Choice; variant?: Variant }) {
  const params = new URLSearchParams()
  if (choice) params.set('choice', choice)
  if (variant) params.set('variant', variant)
  return `/new?${params}`
}
