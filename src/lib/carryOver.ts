import { supabase } from './supabase'

/**
 * Moving what a reader made without an account to the account they sign in to.
 *
 * Signing in replaces the anonymous session with the account's, and nothing
 * the anonymous account owns follows by itself — the account may well exist
 * already, and even a new one is a different user. So before the sign-in
 * email goes out, while this browser can still prove it is the anonymous
 * account, it takes out a ticket (`begin_account_carry_over`), and once the
 * account's session arrives it hands the ticket back
 * (`finish_account_carry_over`), which moves the polls, link ballots,
 * confirmations and removals across. See "Polls made without an account" in
 * AGENTS.md.
 *
 * The ticket lives in `localStorage` rather than in memory because a sign-in
 * link opens a new tab: the session it mints reaches every tab of this browser,
 * and whichever of them sees it first redeems the ticket. The database spends
 * a ticket once, so two tabs racing is harmless. A link opened in another
 * browser cannot redeem it — that browser never had it — and the polls stay
 * with the anonymous session here until this browser signs in.
 */
const KEY = 'star-voting:carry-over'

/**
 * Takes out a ticket for the anonymous account signed in here. A failure is
 * let go: signing in matters more than what it brings along, and is not
 * held up by it.
 */
export async function beginCarryOver(): Promise<void> {
  const { data, error } = await supabase.rpc('begin_account_carry_over')
  if (error || typeof data !== 'string') return
  try {
    localStorage.setItem(KEY, data)
  } catch {
    // Nowhere to keep it, so nothing will be carried over.
  }
}

/**
 * Redeems the ticket this browser holds, if any, for the account now signed
 * in. The ticket is dropped once the database has answered either way: an
 * answer of nothing moved means it was spent or expired, and trying again
 * would only be told the same.
 */
export async function finishCarryOver(): Promise<void> {
  let token: string | null
  try {
    token = localStorage.getItem(KEY)
  } catch {
    return
  }
  if (!token) return
  const { error } = await supabase.rpc('finish_account_carry_over', { p_token: token })
  // A request that did not reach the database keeps the ticket for the next
  // time the app opens under this account.
  if (error && !error.code) return
  try {
    localStorage.removeItem(KEY)
  } catch {
    // Spent in the database either way.
  }
}
