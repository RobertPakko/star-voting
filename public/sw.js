/**
 * The service worker, which exists mostly so the app can be installed: an
 * installable web app has to control a scope, and this is the smallest thing
 * that does it honestly rather than an empty file registered to satisfy the
 * check.
 *
 * What it does not try to be is an offline copy of the app. A poll lives in
 * Supabase; every page worth reading is a read against it, so a plane-mode
 * launch can show the shell and then has nothing to put in it. Caching what
 * the network would have said about a poll would be worse than useless — a
 * closed poll drawn as still collecting, a vote shown as cast that never
 * left the phone — so requests that leave this origin are not touched at
 * all. What is cached is the shell: the HTML, the bundle, the icons. That
 * makes a launch from the home screen quick, and makes an offline one say
 * "we cannot reach the server" in the app's own words instead of the
 * browser's error page.
 *
 * Bump VERSION when this file changes; the name is what makes the old caches
 * old, and activate throws them away.
 */

const VERSION = 'v1'
const CACHE = `star-voting-${VERSION}`

// This file is served from the app's own directory, so its own URL is the
// scope, the start URL, and the prefix every request below is measured
// against — no build-time base to keep in step with vite.config.ts.
const SCOPE = new URL('./', self.location.href)
const SHELL = SCOPE.href

self.addEventListener('install', (event) => {
  // The shell only. Everything else the app needs is hashed into filenames
  // this file cannot know, and lands in the same cache on first use.
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.add(SHELL))
      .catch(() => {
        // Installing fails the registration, and a shell that could not be
        // fetched this second is one the first navigation will cache anyway.
        // Better a worker with an empty cache than no worker at all.
      }),
  )
  // Take over from the previous worker at once, rather than waiting for
  // every tab holding it to close. The usual reason not to is that the old
  // page can still ask for a lazily-loaded chunk the new worker has just
  // dropped from the cache — the About page's sample poll is the app's one
  // such chunk — but that only bites a tab left open across a deploy, which
  // has already lost that chunk from the server. Against it: a worker that
  // waits is one nobody can be sure has ever activated.
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  // Supabase, and anything else off-origin, is left to the network: see
  // above on why a cached answer about a poll is a wrong answer. Files
  // outside the app's own directory are somebody else's to serve.
  if (url.origin !== self.location.origin || !url.href.startsWith(SCOPE.href)) return

  event.respondWith(request.mode === 'navigate' ? shell(event) : asset(event))
})

/**
 * Worth keeping?
 *
 * An error page is a fine thing to show once and a terrible thing to keep,
 * and an opaque response cannot be read to tell which it is. A redirected one
 * is refused by the Cache API outright — `put` throws rather than storing it
 * — which is worth catching here rather than as a failed response later.
 */
function cacheable(response) {
  return response.ok && response.type === 'basic' && !response.redirected
}

/**
 * The page, from the network when there is one.
 *
 * Network-first rather than cache-first, because the HTML is the one file
 * whose name never changes: it is what names the current bundle, and serving
 * yesterday's copy would launch yesterday's app. The cost is one small round
 * trip on launch; the cached copy is what an offline launch gets.
 *
 * Every address in the app is this one file — routing is in the hash, and the
 * magic-link redirect adds a query string — so it is cached under the start
 * URL rather than under whichever of its spellings was asked for first.
 */
async function shell(event) {
  let response
  try {
    response = await fetch(event.request)
  } catch (error) {
    const cached = await caches.match(SHELL)
    if (cached) return cached
    throw error
  }

  if (cacheable(response)) {
    const copy = response.clone()
    event.waitUntil(
      caches
        .open(CACHE)
        .then((cache) => cache.put(SHELL, copy))
        // Storage can be full, and a shell that did not make it into the
        // cache costs an offline launch, not this one.
        .catch(() => {}),
    )
  }
  return response
}

/**
 * Everything else under the app's directory: the bundle, the stylesheet, the
 * icons, the manifest.
 *
 * Cache-first, and then kept up to date in the background. The bundle and
 * stylesheet carry a content hash in their names, so a cached one is never
 * the wrong one and the refresh is a no-op; the handful of files that keep
 * their names across builds — the icons, the manifest, logo.png — are worth
 * a stale first read to save a request on every launch, and are right again
 * by the next one.
 */
async function asset(event) {
  const { request } = event
  const cache = await caches.open(CACHE)
  const cached = await cache.match(request)

  const fresh = fetch(request)
    .then((response) => {
      if (cacheable(response)) cache.put(request, response.clone()).catch(() => {})
      return response
    })
    .catch((error) => {
      if (cached) return cached
      throw error
    })

  // The refresh outlives the response it is not part of: without this the
  // worker can be stopped the moment the cached copy is handed over, and the
  // file never gets its update.
  event.waitUntil(fresh)
  return cached ?? fresh
}
