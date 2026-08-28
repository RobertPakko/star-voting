import { createContext, useContext } from 'react'
import type { Session } from '@supabase/supabase-js'
import type { SignInMethod } from './signInMethod'

/**
 * The session, and the one way into it.
 *
 * The context and its hook live here rather than beside the provider that
 * fills them in: a file that exports a component *and* a hook is a file Fast
 * Refresh cannot reload without throwing the module's state away, so React's
 * refresh boundary is drawn exactly here. `AuthProvider` is the component,
 * in `AuthProvider.tsx`; everything a caller needs is this file, which is
 * why every `useAuth` import still reads `from '../lib/auth'`.
 */
export interface AuthContextValue {
  session: Session | null
  loading: boolean
  /**
   * Sends the sign-in email. `method` decides which of the two goes out —
   * see lib/signInMethod.ts — and is carried to the mailer by the redirect
   * address, because it is the only part of the request the email template
   * can read.
   */
  signInWithEmail: (email: string, method: SignInMethod) => Promise<void>
  /**
   * Redeems a code from the second of those emails, which is a sign-in that
   * never leaves this window. It throws for a code that is wrong and for one
   * that has expired, and Supabase deliberately does not say which.
   *
   * Nothing is returned: the session it mints is saved by the client and
   * arrives here the way every other session does, through the provider's
   * `onAuthStateChange` listener.
   */
  verifySignInCode: (email: string, code: string) => Promise<void>
}

export const AuthContext = createContext<AuthContextValue | undefined>(undefined)

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider')
  return ctx
}
