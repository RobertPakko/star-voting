import { createContext, useContext } from 'react'
import type { Session } from '@supabase/supabase-js'

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
  signInWithEmail: (email: string) => Promise<void>
}

export const AuthContext = createContext<AuthContextValue | undefined>(undefined)

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider')
  return ctx
}
