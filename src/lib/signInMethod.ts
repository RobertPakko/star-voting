/**
 * Which of the two sign-in emails a reader gets: a link to tap, or a code to
 * type in.
 *
 * A link is easier nearly always, and is the default. What it depends on is
 * the tap landing back in *this* window, which is not in the reader's gift: an
 * email client that opens links in a webview of its own signs you in inside
 * that webview, and an installed copy of this app is a separate window a link
 * from an inbox cannot reach. Neither is a fault the app can detect and
 * neither is rare, so the choice is offered rather than guessed at.
 *
 * A code goes the other way: nothing is tapped, nothing navigates, and the
 * window that asked is the window that gets the session.
 *
 * **Supabase renders one template for both.** `signInWithOtp` has no argument
 * for choosing — the same request sends whichever email the *Magic Link*
 * template draws, and it draws whichever of `{{ .ConfirmationURL }}` and
 * `{{ .Token }}` it mentions. The one thing in the request that reaches the
 * template and is ours to set is the redirect address, as `{{ .RedirectTo }}`,
 * so that carries the choice. See `redirectFor` in `AuthProvider.tsx` and
 * [Signing in](../../AGENTS.md#signing-in).
 */

export type SignInMethod = 'link' | 'code'

/**
 * The marker appended to the redirect address on the code path, and the whole
 * of what the email template branches on. Changing it means changing the
 * template in the Supabase dashboard in the same breath — a template looking
 * for the old marker sends a link to everybody, silently.
 */
export const CODE_METHOD_MARKER = 'method=code'

/**
 * How many digits the code has, which is **Authentication → Sign In /
 * Providers → Email OTP Length** in the Supabase dashboard rather than
 * something the app can ask for. Supabase's default is 6; this project is set
 * to 8. Get it wrong and the reader fills every digit they were sent without
 * the last box ever filling, which is why `MIN_CODE_LENGTH` exists.
 */
export const CODE_LENGTH = 8

/**
 * The shortest code Supabase will issue, and where the button under the boxes
 * unlocks. Typing the last digit submits on its own, which is the path nearly
 * every reader takes; this is for the one looking at a screen built for more
 * digits than they were sent.
 */
export const MIN_CODE_LENGTH = 6

const STORAGE_KEY = 'star-voting:sign-in-method'

/**
 * What this browser asked for last time, offered back as the selected option.
 *
 * **Per browser, not per account**, because that is what the problem is:
 * whether a tap on a link comes back to the window that asked is a fact about
 * this device and this email client. Storing it against the account would also
 * mean reading it before there is a session to read it from, which is the one
 * thing a sign-in screen cannot do.
 */
export function rememberedSignInMethod(): SignInMethod {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'code' ? 'code' : 'link'
  } catch {
    // Private browsing, or storage disabled. The default is the default.
    return 'link'
  }
}

/** Remembers the choice an email actually went out under. */
export function rememberSignInMethod(method: SignInMethod): void {
  try {
    localStorage.setItem(STORAGE_KEY, method)
  } catch {
    // Nothing lost: the next sign-in starts on the default, and the control is
    // still there to change.
  }
}
