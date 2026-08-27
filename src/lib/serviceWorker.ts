/**
 * Registers `public/sw.js`, which is what lets a browser offer to install the
 * app: a manifest on its own gets you a nicer bookmark, and the install
 * prompt only appears for a page a service worker controls.
 *
 * The worker is deliberately not registered in development. `vite dev` serves
 * modules straight from source and a worker caching them hands you the
 * previous edit on the next reload, which is a long afternoon before anybody
 * thinks to look in Application → Service Workers. Registering it only in the
 * built app also means the copy under test is the copy that ships: `npm run
 * preview` serves the real thing.
 *
 * The URL is built from BASE_URL rather than written out, so it stays the
 * app's own directory if `base` in vite.config.ts ever moves — and the
 * worker's scope, which defaults to the directory it was served from, moves
 * with it.
 */
export function registerServiceWorker() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return

  // After load: registering fetches and starts the worker, and there is
  // nothing it can do for the page currently painting that is worth
  // competing with it for the connection.
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {
      // Workers are unavailable in some private-browsing modes, and blocked
      // outright by some policies. Nothing here is load-bearing: the app
      // runs exactly as it did before, it just cannot be installed.
    })
  })
}
