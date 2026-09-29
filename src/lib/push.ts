import { useEffect, useSyncExternalStore } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from './supabase'

/**
 * Push notifications, as far as the browser is concerned: whether this device
 * can have them, asking for them, and the two ways a subscription is put to
 * use.
 *
 * **One subscription per browser, two uses of it.** A browser's push
 * subscription is one endpoint, whoever is using it, and it reaches this app's
 * database through one of two doors:
 *
 * - **bound to an account** (`save_push_subscription`), so it hears about
 *   every poll that account is in — the invitations, voting opening, the
 *   results — exactly as that account's inbox does, subject to the account's
 *   settings. This needs somebody signed in, and it is undone on signing out,
 *   because a shared browser that stays bound is the next person's phone
 *   buzzing with the last person's polls.
 * - **watching one open poll** (`open_poll_watch`), with no account and nothing
 *   else attached, so it hears that poll open and finish. This is the gap an
 *   email could never close: an open poll's voters gave no address.
 *
 * What each door is and is not allowed to record is the migration's business;
 * see 0072_push_notifications.sql.
 *
 * **Asking is always a press.** Browsers ignore, or quietly block, a
 * permission prompt that no gesture asked for, and Safari will not show one at
 * all — so nothing here asks on its own, and every function that can prompt is
 * called straight from a click handler, with the permission request as its
 * first await.
 */

const PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY || ''

export type DevicePlatform = 'ios' | 'android' | 'desktop'

/**
 * Which set of installation steps apply to this device.
 *
 * iPadOS reports itself as a Mac, so a Mac with a touch screen is an iPad:
 * there is no touch-screen Mac.
 */
export function devicePlatform(): DevicePlatform {
  const agent = navigator.userAgent
  if (/iPhone|iPad|iPod/.test(agent) || (/Macintosh/.test(agent) && navigator.maxTouchPoints > 1)) {
    return 'ios'
  }
  if (/Android/.test(agent)) return 'android'
  return 'desktop'
}

/** Whether this page is the installed app, rather than a tab in a browser. */
export function isInstalledApp(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  )
}

/**
 * Where this device stands, in the order a reader would have to fix it.
 *
 * - `unconfigured`: this build has no VAPID key, so push is off for everybody.
 * - `needs-install`: an iPhone or iPad in a browser tab. Apple only gives the
 *   push APIs to a site added to the home screen, so there is nothing to ask
 *   for until it is.
 * - `unsupported`: a browser with no push at all.
 * - `denied`: the reader said no, and only the browser's own settings can undo
 *   that — a site is not allowed to ask twice.
 * - `ask`: nothing decided yet.
 * - `granted`: allowed. Whether a subscription exists is a separate question.
 */
export type PushState =
  | 'unconfigured'
  | 'needs-install'
  | 'unsupported'
  | 'denied'
  | 'ask'
  | 'granted'

export function pushState(): PushState {
  if (!PUBLIC_KEY) return 'unconfigured'
  const capable =
    'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
  if (!capable) {
    return devicePlatform() === 'ios' && !isInstalledApp() ? 'needs-install' : 'unsupported'
  }
  if (Notification.permission === 'denied') return 'denied'
  if (Notification.permission === 'granted') return 'granted'
  return 'ask'
}

/** Whether pressing a button here can end in a subscription. */
export function canAskForPush(state: PushState = pushState()): boolean {
  return state === 'ask' || state === 'granted'
}

/** Said when the reader dismisses the browser's prompt or says no. */
export class PushRefused extends Error {
  constructor() {
    super('Notifications were not allowed. You can change that in your browser’s settings.')
  }
}

function base64urlToBytes(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

function sameKey(buffer: ArrayBuffer | null, key: string): boolean {
  if (!buffer) return false
  const a = new Uint8Array(buffer)
  const b = base64urlToBytes(key)
  return a.length === b.length && a.every((byte, i) => byte === b[i])
}

/**
 * The service worker's registration, waited for if the page is new.
 *
 * `serviceWorker.ts` registers it on `load`, so a button pressed in the first
 * second can arrive before it exists. Under `vite dev` it never will — the
 * worker is only registered in the built app — and that is said rather than
 * waited on for ever.
 */
async function registration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration()
  if (existing) return existing
  const ready = await Promise.race([
    navigator.serviceWorker.ready,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000)),
  ])
  if (!ready) throw new Error('Notifications are not available on this page. Try reloading it.')
  return ready
}

/** This browser's subscription, without asking for anything. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!canAskForPush()) return null
  const found = await navigator.serviceWorker.getRegistration()
  const subscription = (await found?.pushManager.getSubscription()) ?? null
  // One made against a key this build no longer uses cannot be sent to.
  return subscription && sameKey(subscription.options.applicationServerKey, PUBLIC_KEY)
    ? subscription
    : null
}

/**
 * Asks for permission if it has not been given, and returns this browser's
 * subscription — the existing one where there is one.
 *
 * Call it from a click handler and nowhere else: see the note at the top.
 */
async function subscribe(): Promise<PushSubscription> {
  if (!PUBLIC_KEY) throw new Error('Notifications are not set up on this site.')
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new PushRefused()

  const found = await registration()
  const existing = await found.pushManager.getSubscription()
  if (existing && sameKey(existing.options.applicationServerKey, PUBLIC_KEY)) return existing
  // A subscription under a rotated key is one the sender can no longer sign
  // for; a browser holds one subscription at a time, so it has to go first.
  if (existing) await existing.unsubscribe()
  return found.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: base64urlToBytes(PUBLIC_KEY),
  })
}

function keysOf(subscription: PushSubscription) {
  const { keys } = subscription.toJSON()
  return {
    p_endpoint: subscription.endpoint,
    p_p256dh: keys?.p256dh ?? '',
    p_auth: keys?.auth ?? '',
  }
}

// ---------------------------------------------------------------------------
// Bound to an account
// ---------------------------------------------------------------------------

/**
 * Which account this browser bound itself to, remembered so that the binding
 * can be refreshed when the app opens and taken back when that account signs
 * out. The database is the truth about whether it is bound; this is only what
 * lets the browser act on it without asking.
 */
const ACCOUNT_KEY = 'star-voting:push-account'

function readAccount(): string | null {
  try {
    return localStorage.getItem(ACCOUNT_KEY)
  } catch {
    return null
  }
}

function writeAccount(userId: string | null) {
  try {
    if (userId) localStorage.setItem(ACCOUNT_KEY, userId)
    else localStorage.removeItem(ACCOUNT_KEY)
  } catch {
    // The binding still holds in the database; it just will not be refreshed
    // or forgotten from here, which is the same bargain voterKey.ts strikes.
  }
}

/** Turns notifications on for the signed-in account, on this device. */
export async function enableAccountPush(userId: string): Promise<void> {
  const subscription = await subscribe()
  const { error } = await supabase.rpc('save_push_subscription', keysOf(subscription))
  if (error) throw new Error(error.message)
  writeAccount(userId)
}

/** Stops this device hearing about the signed-in account's polls. */
export async function disableAccountPush(): Promise<void> {
  const subscription = await currentSubscription()
  if (subscription) {
    const { error } = await supabase.rpc('forget_push_subscription', {
      p_endpoint: subscription.endpoint,
    })
    if (error) throw new Error(error.message)
  }
  writeAccount(null)
}

/**
 * Re-saves this device for the account it was bound to, on opening the app.
 *
 * Push services rotate endpoints — rarely, and without telling the site — and
 * a rotated one is only ever discovered by a send that fails. Saving the
 * current one whenever the app opens under that account keeps the database
 * pointing at the endpoint that works. It asks for nothing: it only runs where
 * permission is already granted.
 */
export async function refreshAccountPush(userId: string): Promise<void> {
  if (readAccount() !== userId || pushState() !== 'granted') return
  try {
    const found = await navigator.serviceWorker.getRegistration()
    if (!found) return
    let subscription = await found.pushManager.getSubscription()
    if (!subscription || !sameKey(subscription.options.applicationServerKey, PUBLIC_KEY)) {
      await subscription?.unsubscribe()
      subscription = await found.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64urlToBytes(PUBLIC_KEY),
      })
    }
    await supabase.rpc('save_push_subscription', keysOf(subscription))
  } catch {
    // Best-effort, on a page that did not ask for it. The settings page says
    // honestly whether this device is still bound.
  }
}

/**
 * Takes this device off the account before it signs out, while there is still
 * a session to do it with.
 */
export async function forgetAccountPush(): Promise<void> {
  if (!readAccount()) return
  try {
    await disableAccountPush()
  } catch {
    // Signing out must not fail because of this; the flag goes regardless,
    // and a send to a device nobody is signed in to is the worst case left.
    writeAccount(null)
  }
}

// ---------------------------------------------------------------------------
// Watching an open poll
// ---------------------------------------------------------------------------

/**
 * The polls this browser has asked to hear about, by the key the page knows
 * the poll by — its group, so that every question of a poll shows the same
 * answer. Only ever a mirror of the database, kept so a button can say which
 * way round it is without a request; the watch itself is what the database
 * holds, and it is deleted there when the results go out.
 */
const WATCHED_KEY = 'star-voting:watched-polls'

const NONE: ReadonlySet<string> = new Set()
let watched = readWatched()
const watchers = new Set<() => void>()

function readWatched(): ReadonlySet<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(WATCHED_KEY) ?? '[]')
    if (!Array.isArray(parsed)) return NONE
    const keys = parsed.filter((key): key is string => typeof key === 'string')
    return keys.length > 0 ? new Set(keys) : NONE
  } catch {
    return NONE
  }
}

function setWatched(key: string, on: boolean) {
  if (watched.has(key) === on) return
  const next = new Set(watched)
  if (on) next.add(key)
  else next.delete(key)
  watched = next.size > 0 ? next : NONE
  try {
    if (watched.size === 0) localStorage.removeItem(WATCHED_KEY)
    else localStorage.setItem(WATCHED_KEY, JSON.stringify([...watched]))
  } catch {
    // Kept for this tab; see readAccount.
  }
  for (const notify of watchers) notify()
}

function subscribeWatched(notify: () => void) {
  watchers.add(notify)
  return () => {
    watchers.delete(notify)
  }
}

/** Whether this browser is watching the poll known by `key`, live. */
export function useWatching(key: string): boolean {
  const set = useSyncExternalStore(
    subscribeWatched,
    () => watched,
    () => NONE,
  )
  return set.has(key)
}

/** Asks to hear when this open poll opens for voting and when it finishes. */
export async function watchPoll(pollId: string, key: string): Promise<void> {
  const subscription = await subscribe()
  const { error } = await supabase.rpc('open_poll_watch', {
    p_poll_id: pollId,
    ...keysOf(subscription),
  })
  if (error) throw new Error(error.message)
  setWatched(key, true)
}

/** Takes that back. */
export async function unwatchPoll(pollId: string, key: string): Promise<void> {
  const subscription = await currentSubscription()
  if (subscription) {
    const { error } = await supabase.rpc('open_poll_unwatch', {
      p_poll_id: pollId,
      p_endpoint: subscription.endpoint,
    })
    if (error) throw new Error(error.message)
  }
  setWatched(key, false)
}

/**
 * Drops the mirror once a poll has nothing left to announce — the database
 * deleted the watch when it sent the results, and a reopened poll would
 * otherwise say "you will be notified" about a watch that no longer exists.
 */
export function forgetWatch(key: string): void {
  setWatched(key, false)
}

// ---------------------------------------------------------------------------
// Arriving from a notification
// ---------------------------------------------------------------------------

/** The note a tapped notification leaves behind; see `rememberOpen` in public/sw.js. */
const OPEN_CACHE = 'star-voting-open'
/** Older than this, a note is a tap nobody's app picked up, not one to act on now. */
const OPEN_FRESH_MS = 2 * 60_000

/**
 * Takes the destination a tapped notification left, if there is a fresh one,
 * and deletes it so it is acted on once.
 *
 * `caches.has` first, because `caches.open` would create the cache — an empty
 * one in every browser that ever loaded the app, for a note most never get.
 */
async function takeNotificationPath(): Promise<string | null> {
  if (typeof caches === 'undefined') return null
  try {
    if (!(await caches.has(OPEN_CACHE))) return null
    const cache = await caches.open(OPEN_CACHE)
    const key = new URL('__notification-open', new URL(import.meta.env.BASE_URL, location.origin))
      .href
    const response = await cache.match(key)
    if (!response) return null
    await cache.delete(key)
    const note = (await response.json()) as { path?: unknown; at?: unknown }
    if (typeof note.path !== 'string' || !note.path.startsWith('#/')) return null
    if (typeof note.at !== 'number' || Date.now() - note.at > OPEN_FRESH_MS) return null
    return note.path
  } catch {
    return null
  }
}

/**
 * Takes the app to the poll a tapped notification is about.
 *
 * Three ways in, because each of the ways a tap can arrive fails somewhere:
 *
 * - **A message**, when the app was already open: the service worker focuses
 *   the window and posts it the poll's hash, and the app moves the way it moves
 *   for any link — no reload, nothing lost.
 * - **On starting**, for an app the tap launched. The worker opens the poll's
 *   own address, but an iPhone launching the installed app from a
 *   notification opens its start page instead, so the note the worker left is
 *   read here.
 * - **On coming back to the foreground**, for an app that was suspended and
 *   resumed without the message ever arriving.
 *
 * The note is deleted whichever way it is acted on, so the same tap cannot
 * move the reader twice. See `notificationclick` in public/sw.js.
 */
export function useNotificationRoutes(): void {
  const navigate = useNavigate()
  useEffect(() => {
    let alive = true

    function go(path: string) {
      // Already there — the launch that honoured the poll's address — needs no
      // second entry in the history for the back button to walk through.
      if (alive && window.location.hash !== path) navigate(path.slice(1))
    }

    async function check() {
      const path = await takeNotificationPath()
      if (path) go(path)
    }

    function onMessage(event: MessageEvent) {
      const data = event.data as { type?: unknown; path?: unknown } | null
      if (data?.type !== 'open-path' || typeof data.path !== 'string') return
      if (!data.path.startsWith('#/')) return
      // Taken as well, or coming back to the foreground a minute later would
      // act on the same tap a second time.
      void takeNotificationPath()
      go(data.path)
    }

    function onVisible() {
      if (document.visibilityState === 'visible') void check()
    }

    void check()
    document.addEventListener('visibilitychange', onVisible)
    navigator.serviceWorker?.addEventListener('message', onMessage)
    // Messages from a worker wait in a queue until the page says it is
    // listening; saying so here rather than relying on the page having
    // finished loading is what makes one sent at launch arrive.
    navigator.serviceWorker?.startMessages()
    return () => {
      alive = false
      document.removeEventListener('visibilitychange', onVisible)
      navigator.serviceWorker?.removeEventListener('message', onMessage)
    }
  }, [navigate])
}

// ---------------------------------------------------------------------------
// The banner
// ---------------------------------------------------------------------------

const BANNER_KEY = 'star-voting:app-banner-dismissed'

/** Whether the reader has closed the "you can install this" banner for good. */
export function appBannerDismissed(): boolean {
  try {
    return localStorage.getItem(BANNER_KEY) === '1'
  } catch {
    return false
  }
}

export function dismissAppBanner(): void {
  try {
    localStorage.setItem(BANNER_KEY, '1')
  } catch {
    // Closed for this page, then; it comes back on the next.
  }
}
