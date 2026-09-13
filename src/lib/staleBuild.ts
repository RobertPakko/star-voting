/**
 * Reloads the page when it reaches for a file the last deploy took away.
 *
 * The app is split: the results cards and the calendar are fetched when a
 * poll needs them (see components/deferred.ts), the create form and the About
 * page when somebody navigates to them (the `lazy` calls in App.tsx), the
 * sample poll's data when the sample is opened (lib/samplePoll.ts). Every one
 * of those files carries a content hash in its name, and the page that names
 * them is the `index.html` the tab loaded.
 *
 * A deploy replaces the whole site in one go -- deploy.yml uploads a freshly
 * built `dist/` as the Pages artifact, and nothing of the build before it
 * survives. So the hashed names an *already open* tab is holding stop
 * resolving the moment a deploy lands, and stay that way until that tab loads
 * the page again. That is not the few seconds the deploy takes: it is however
 * long the tab stays open, which on a phone, or in the installed app, is days.
 *
 * Nothing is wrong until the tab reaches for one of those files. Then the
 * import 404s, and since a rejected `lazy()` throws during render with nothing
 * catching it, React unmounts the app: a blank page, and "Failed to fetch
 * dynamically imported module" in a console the reader is not looking at.
 *
 * What fixes it is a reload -- the page is fetched network-first (see
 * public/sw.js) so it comes back naming the files that do exist. This does
 * that for the reader instead of leaving them to find it. Hash routing means
 * the address survives the reload, so they land back where they were and the
 * import they were waiting on is simply tried again, against the new build.
 *
 * The same reload is the right answer to the one other way this fails: a file
 * that is genuinely there but was not served, mid-deploy or from an edge that
 * had not caught up yet. Heavier than a retry, and it is the rarer case.
 *
 * **The hook is Vite's.** Its build wraps every dynamic import, and dispatches
 * `vite:preloadError` on the window when the module -- or a stylesheet split
 * out with it -- cannot be loaded. One listener therefore covers all six
 * splits above and any added later, which is the point of using it rather than
 * an error boundary per `Suspense`: nothing has to be remembered at the call
 * site. The event is only ever dispatched by the built app; `vite dev` serves
 * modules straight from source and never goes through that wrapper.
 *
 * The error is left to throw afterwards. Preventing that is offered, but it
 * only swaps this failure for the next one -- the import resolves as
 * `undefined` and `lazy()` reads a component off it -- and the page is on its
 * way out regardless.
 */

/** When this tab last reloaded itself for this reason, if it has. */
const MARKER = 'star-voting:stale-build-reload'

/**
 * How recent a reload of our own has to be for the next failure to look like
 * the first one repeating rather than a new one.
 *
 * This is the whole of the loop protection, and it is the part worth being
 * careful about: a reload that does not fix the import puts the tab straight
 * back where it was, and a reload on *every* failure is a page that reloads
 * forever. Nothing here can tell the two apart except the clock. A reload and
 * the retry that follows it are a page load apart, so a second failure within
 * a few seconds is the loop; one an hour later is the next deploy, and should
 * be reloaded for like any other.
 */
const LOOP_WINDOW_MS = 10_000

/** Whether this tab has already reloaded itself too recently to do it again. */
function reloadedJustNow(): boolean {
  const at = Number(sessionStorage.getItem(MARKER))
  // An absent marker reads as 0 and a corrupted one as NaN, and neither is a
  // reload this tab made. A clock that has gone backwards lands here as a
  // negative age, which is counted as recent: refusing to reload is the safe
  // way to be wrong.
  if (!at) return false
  return Date.now() - at < LOOP_WINDOW_MS
}

/**
 * Starts listening. Called once, from main.tsx.
 *
 * `sessionStorage` rather than `localStorage`: the marker is about this tab's
 * own last few seconds, and a second tab hitting the same dead chunk is a
 * second reader who should get their own reload rather than be counted as this
 * one looping.
 */
export function reloadOnStaleBuild(): void {
  window.addEventListener('vite:preloadError', () => {
    try {
      if (reloadedJustNow()) return
      sessionStorage.setItem(MARKER, String(Date.now()))
    } catch {
      // Storage refused -- private browsing, or a policy. A reload we cannot
      // write down is one we cannot recognise the repeat of, which is exactly
      // the case that loops, so this is where we stop and let the error
      // through. The reader gets the refresh they were getting before.
      return
    }
    window.location.reload()
  })
}
