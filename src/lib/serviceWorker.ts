/**
 * Registers `public/sw.js`, which is what lets a browser offer to install the
 * app: a manifest alone gets you a nicer bookmark, and the install prompt
 * only appears for a page a service worker controls.
 *
 * **Not in development.** `vite dev` serves modules straight from source and a
 * worker caching them hands you the previous edit on the next reload, which is
 * a long afternoon before anybody thinks to look in Application → Service
 * Workers. Registering only in the built app also means the copy under test is
 * the copy that ships: `npm run preview` serves the real thing.
 *
 * The URL is built from BASE_URL rather than written out, so it — and the
 * worker's scope, which defaults to the directory it was served from — follow
 * `base` in vite.config.ts if it ever moves.
 */
export function registerServiceWorker() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return

  // After load: registering fetches and starts the worker, and nothing it can
  // do for the page currently painting is worth competing for the connection.
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {
      // Unavailable in some private-browsing modes and blocked by some
      // policies. Nothing here is load-bearing: the app runs exactly as it
      // did, it just cannot be installed.
    })
    void retireOldWorker()
  })
}

/**
 * Takes down the worker registered when the app lived under /star-voting/.
 *
 * Left alone it would go on controlling that path, which the site no longer
 * serves, serving a stale copy of the old app from its cache, and holding push subscriptions bound to a worker the app no
 * longer talks to. Unregistering drops them: a device bound to an account is
 * subscribed again under this worker the next time the app opens signed in
 * (`refreshAccountPush`), and the push services refuse the old endpoints, so
 * the database forgets them the first time it sends. A watch on an open poll
 * filed from the old address is lost, which is the one cost of the move.
 */
async function retireOldWorker() {
  try {
    const registrations = await navigator.serviceWorker.getRegistrations()
    const old = new URL('/star-voting/', window.location.origin).href
    await Promise.all(registrations.filter((r) => r.scope === old).map((r) => r.unregister()))
  } catch {
    // Nothing depends on it; a worker left behind controls only the old path.
  }
}
