/**
 * The service worker, which exists so the app can be installed and so it can
 * be told about a poll while it is closed: an installable web app has to
 * control a scope, and a push notification is delivered to a service worker
 * rather than to a page. Both halves are below — the caching first, the push
 * handlers at the end.
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

const VERSION = 'v3'
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
  // has already lost that chunk from the server and is reloaded for it by
  // lib/staleBuild.ts. Against it: a worker that
  // waits is one nobody can be sure has ever activated.
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE && key !== OPEN_CACHE)
            .map((key) => caches.delete(key)),
        ),
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

/**
 * A push, which is always a notification.
 *
 * Browsers insist on that — a push that shows nothing is counted against the
 * site, and Safari revokes the permission after a few — and it is also all a
 * push here is for: the database has already decided who hears about which
 * moment, in the same functions that decide the emails, and written the words
 * (see `push_message` in 0072_push_notifications.sql). The payload is a title,
 * a sentence, and where the poll is.
 *
 * `tag` is the poll, so a second notification about the same poll replaces
 * the first rather than stacking under it, and `renotify` makes the
 * replacement still sound — "voting is open" followed by "the results are
 * ready" is two pieces of news, not one updated.
 */
self.addEventListener('push', (event) => {
  let message = {}
  try {
    message = event.data ? event.data.json() : {}
  } catch {
    // A payload that is not JSON is not one this app sent. It still has to
    // show something, and the app's own name is the honest minimum.
  }

  const title = typeof message.title === 'string' && message.title ? message.title : 'STAR Voting'
  // Only ever a place inside the app: a path is resolved against the scope and
  // must start with the hash every route here lives in.
  const path = typeof message.path === 'string' && message.path.startsWith('#') ? message.path : ''
  const tag = typeof message.tag === 'string' && message.tag ? message.tag : undefined

  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof message.body === 'string' ? message.body : '',
      icon: new URL('icon-192.png', SCOPE).href,
      tag,
      renotify: !!tag,
      data: { url: new URL(path, SCOPE).href, path },
    }),
  )
})

/**
 * Where a tapped notification was asking to go, left where the app can find
 * it: a cache of its own (kept out of the version sweep in `activate`), under
 * one fixed key, read and deleted by `useNotificationRoutes` in
 * src/lib/push.ts.
 *
 * It exists because neither way of telling the app directly is reliable.
 * `openWindow(url)` is supposed to open the poll's address, and an iPhone
 * launching the installed app from a notification opens its start page
 * instead. A window found by `matchAll` is supposed to take a `postMessage`,
 * and a suspended one can resume without it. Both are still tried; this is
 * what the app falls back on when it starts or comes back to the foreground,
 * so the tap lands on the poll however it was delivered. It is stamped, and
 * the app ignores one more than a couple of minutes old, so a note nobody
 * picked up cannot move somebody days later.
 */
const OPEN_CACHE = 'star-voting-open'
const OPEN_KEY = new URL('__notification-open', SCOPE).href

async function rememberOpen(path) {
  try {
    const cache = await caches.open(OPEN_CACHE)
    await cache.put(
      OPEN_KEY,
      new Response(JSON.stringify({ path, at: Date.now() }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    )
  } catch {
    // Storage refused: the message and the address are still tried below.
  }
}

/**
 * A tap on a notification opens its poll.
 *
 * In the app window that is already open, when there is one, rather than a
 * second copy of it: that window is told where to go and routes there itself,
 * so nothing reloads and nothing it was holding is lost. With no window open,
 * one is opened on the poll's address. Either way the destination is written
 * down first (`rememberOpen`), because either way can arrive at the wrong
 * page; see above.
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const { url, path } = event.notification.data ?? {}

  event.waitUntil(
    (async () => {
      // First, so the note is there before any window could look for it. A
      // cache write is a few milliseconds, well inside the time a click
      // leaves for opening a window.
      if (path) await rememberOpen(path)

      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const open = windows.find((client) => client.url.startsWith(SCOPE.href))
      if (open) {
        try {
          await open.focus()
        } catch {
          // Not allowed to take focus; the note is waiting for when it does.
        }
        if (path) open.postMessage({ type: 'open-path', path })
        return
      }
      await self.clients.openWindow(url || SHELL)
    })(),
  )
})
