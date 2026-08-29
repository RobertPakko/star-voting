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
  })
}
