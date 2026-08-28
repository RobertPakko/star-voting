import { useEffect, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './supabase'
import { AuthContext } from './auth'
import { CODE_METHOD_MARKER, type SignInMethod } from './signInMethod'

/**
 * Where the sign-in email's link comes back to — and, on the code path, the
 * one part of the request that tells the mailer which email to send.
 *
 * Origin plus pathname with the hash dropped, because the app routes off the
 * hash and the address a link returns to must not carry a route of its own;
 * the same string `shareLink.ts` builds for the same reason. On the code
 * path a marker is appended, and the email template branches on it — see
 * lib/signInMethod.ts for why that is the only lever there is.
 *
 * **Both forms have to be on Supabase's allowed redirect list**, which a
 * single `…/**` entry per deployment covers. One that is not on the list
 * does not fail loudly: Supabase falls back to the Site URL, the template
 * sees an address it does not recognise, and every reader who asked for a
 * code is sent a link instead.
 */
function redirectFor(method: SignInMethod): string {
  const root = window.location.origin + window.location.pathname
  return method === 'code' ? `${root}?${CODE_METHOD_MARKER}` : root
}

/**
 * Holds the Supabase session and keeps it current, for the whole app.
 *
 * The context itself and the `useAuth` hook are in `auth.ts` next door, so
 * this file exports nothing but a component.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoading(false)
    })

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession)
    })

    return () => subscription.subscription.unsubscribe()
  }, [])

  async function signInWithEmail(email: string, method: SignInMethod) {
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: redirectFor(method) },
    })
    if (error) throw error
  }

  async function verifySignInCode(email: string, code: string) {
    // `type: 'email'` covers both halves of what this app's sign-in is —
    // an account signing in again and one being created on first sight —
    // which is the same thing `signInWithOtp` does not distinguish either.
    //
    // The session comes back on this call rather than through a redirect,
    // and the client saves it and announces it: the listener above is what
    // picks it up, so there is nothing to return and nothing to plumb.
    const { error } = await supabase.auth.verifyOtp({ email, token: code, type: 'email' })
    if (error) throw error
  }

  return (
    <AuthContext.Provider value={{ session, loading, signInWithEmail, verifySignInCode }}>
      {children}
    </AuthContext.Provider>
  )
}
