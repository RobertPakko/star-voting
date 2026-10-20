import { useEffect, useSyncExternalStore } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from './supabase'
import { readFlag, writeFlag } from './storage'

/**
 * Push notifications in the browser. A browser has one subscription, used two
 * ways:
 *
 * - **Bound to an account** (`save_push_subscription`): hears about every poll
 *   the account is in, under its settings. Undone on sign-out, so a shared
 *   browser doesn't keep buzzing for the last person.
 * - **Watching one open poll** (`open_poll_watch`), with no account: hears that
 *   poll open and finish.
 *
 * Anything that can prompt must be called straight from a click handler, with
 * the permission request as its first await -- browsers block prompts nobody
 * asked for. See "Push notifications" in AGENTS.md.
 */

const PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY || ''

export type DevicePlatform = 'ios' | 'android' | 'desktop'

/** Which install steps apply. iPadOS reports as a Mac; a touch-screen "Mac" is an iPad. */
export function devicePlatform(): DevicePlatform {
  const agent = navigator.userAgent
  if (/iPhone|iPad|iPod/.test(agent) || (/Macintosh/.test(agent) && navigator.maxTouchPoints > 1)) {
    return 'ios'
  }
  if (/Android/.test(agent)) return 'android'
  return 'desktop'
}

export function isInstalledApp(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  )
}

/**
 * Where this device stands, in the order a reader would have to fix it:
 * no VAPID key in this build; an iPhone/iPad outside the installed app (Apple
 * only offers push there); no push at all; refused (only browser settings can
 * undo it); undecided; or allowed (whether subscribed is a separate question).
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

export function canAskForPush(state: PushState = pushState()): boolean {
  return state === 'ask' || state === 'granted'
}

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
 * The service worker registration, waited for if the page is new (it is
 * registered on `load`). It never appears under `vite dev`, so give up after
 * a while.
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

/** This browser's subscription, without prompting. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!canAskForPush()) return null
  const found = await navigator.serviceWorker.getRegistration()
  const subscription = (await found?.pushManager.getSubscription()) ?? null
  // One made under a different (rotated) key can't be sent to.
  return subscription && sameKey(subscription.options.applicationServerKey, PUBLIC_KEY)
    ? subscription
    : null
}

/** Prompt if needed and return a subscription. Click handlers only. */
async function subscribe(): Promise<PushSubscription> {
  if (!PUBLIC_KEY) throw new Error('Notifications are not set up on this site.')
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new PushRefused()

  const found = await registration()
  const existing = await found.pushManager.getSubscription()
  if (existing && sameKey(existing.options.applicationServerKey, PUBLIC_KEY)) return existing
  // A browser holds one subscription; one under a rotated key must go first.
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
 * The account this browser bound itself to, so the binding can be refreshed
 * on open and dropped on sign-out. The database is the truth; this is a mirror.
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
    // The database binding still holds; it just won't be refreshed from here.
  }
  accountPushChanged()
}

/** A mirror of "the account's push is off", written by the settings switches. */
const ACCOUNT_OFF_KEY = 'star-voting:push-account-off'

export function rememberAccountPush(on: boolean): void {
  writeFlag(ACCOUNT_OFF_KEY, !on)
  accountPushChanged()
}

/**
 * Whether this device is bound to this account and the account wants push,
 * from local mirrors only (no request). Another device's change shows here
 * once this one opens the settings.
 */
export function accountPushHere(userId: string): boolean {
  return pushState() === 'granted' && readAccount() === userId && !readFlag(ACCOUNT_OFF_KEY)
}

/** Bumped whenever a push mirror changes, so `usePushHere` re-renders. */
let accountPushVersion = 0
const accountPushListeners = new Set<() => void>()

function accountPushChanged() {
  accountPushVersion += 1
  for (const notify of accountPushListeners) notify()
}

function subscribeAccountPush(notify: () => void) {
  accountPushListeners.add(notify)
  return () => {
    accountPushListeners.delete(notify)
  }
}

export async function enableAccountPush(userId: string): Promise<void> {
  const subscription = await subscribe()
  const { error } = await supabase.rpc('save_push_subscription', keysOf(subscription))
  if (error) throw new Error(error.message)
  writeAccount(userId)
}

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
 * Re-save this device on app open, since push services rotate endpoints
 * silently. Only runs where permission is already granted.
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
    // Best-effort.
  }
}

/** Unbind before signing out, while there is still a session to do it with. */
export async function forgetAccountPush(): Promise<void> {
  if (!readAccount()) return
  try {
    await disableAccountPush()
  } catch {
    // Sign-out must not fail on this.
    writeAccount(null)
  }
}

// ---------------------------------------------------------------------------
// Watching an open poll
// ---------------------------------------------------------------------------

/**
 * Polls this browser watches, keyed by group (so every question agrees), each
 * with the poll id the watch was filed through (`open_poll_unwatch` needs
 * it). A mirror of the database, which deletes a watch once results go out.
 */
const WATCHED_KEY = 'star-voting:watched-polls'

const NONE: ReadonlyMap<string, string | null> = new Map()
let watched = readWatched()
const watchers = new Set<() => void>()

function readWatched(): ReadonlyMap<string, string | null> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(WATCHED_KEY) ?? '{}')
    // An array is an older build's format, with no poll ids: still honoured,
    // just not revocable from here.
    const entries: [string, string | null][] = Array.isArray(parsed)
      ? parsed.filter((key): key is string => typeof key === 'string').map((key) => [key, null])
      : parsed && typeof parsed === 'object'
        ? Object.entries(parsed).map(([key, id]) => [key, typeof id === 'string' ? id : null])
        : []
    return entries.length > 0 ? new Map(entries) : NONE
  } catch {
    return NONE
  }
}

function setWatched(key: string, pollId: string | null, on: boolean) {
  if (watched.has(key) === on) return
  const next = new Map(watched)
  if (on) next.set(key, pollId)
  else next.delete(key)
  watched = next.size > 0 ? next : NONE
  try {
    if (watched.size === 0) localStorage.removeItem(WATCHED_KEY)
    else localStorage.setItem(WATCHED_KEY, JSON.stringify(Object.fromEntries(watched)))
  } catch {
    // Kept for this tab.
  }
  for (const notify of watchers) notify()
}

function subscribeWatched(notify: () => void) {
  watchers.add(notify)
  return () => {
    watchers.delete(notify)
  }
}

export function useWatching(key: string): boolean {
  const map = useSyncExternalStore(
    subscribeWatched,
    () => watched,
    () => NONE,
  )
  return map.has(key)
}

/** File a watch on an open poll. Doesn't prompt: only called once push is on. */
export async function watchPoll(pollId: string, key: string): Promise<void> {
  const subscription = await currentSubscription()
  if (!subscription) throw new Error('This browser has no push subscription.')
  const { error } = await supabase.rpc('open_poll_watch', {
    p_poll_id: pollId,
    ...keysOf(subscription),
  })
  if (error) throw new Error(error.message)
  setWatched(key, pollId, true)
}

/**
 * Drop the mirror once a poll has finished (the database already deleted the
 * watch), so a reopened poll gets watched again.
 */
export function forgetWatch(key: string): void {
  setWatched(key, null, false)
}

// ---------------------------------------------------------------------------
// Push without an account
// ---------------------------------------------------------------------------

/**
 * The signed-out reader's push switch (`LinkPushSwitch`). Per browser, since
 * there is no account; when on, OpenPollPanel files a watch on each open poll
 * answered here.
 */
const LINK_PUSH_KEY = 'star-voting:push-link-polls'

function writeLinkPush(on: boolean) {
  writeFlag(LINK_PUSH_KEY, on)
  accountPushChanged()
}

export async function enableLinkPush(): Promise<void> {
  await subscribe()
  writeLinkPush(true)
}

/** Turn it off and revoke every watch this browser filed (best-effort per poll). */
export async function disableLinkPush(): Promise<void> {
  writeLinkPush(false)
  const subscription = await currentSubscription()
  await Promise.all(
    [...watched].map(async ([key, pollId]) => {
      if (subscription && pollId) {
        await supabase.rpc('open_poll_unwatch', {
          p_poll_id: pollId,
          p_endpoint: subscription.endpoint,
        })
      }
      setWatched(key, null, false)
    }),
  )
}

/** Whether this device will be pushed to: via the account, or the link switch. Live. */
export function usePushHere(userId: string | undefined): boolean {
  useSyncExternalStore(
    subscribeAccountPush,
    () => accountPushVersion,
    () => 0,
  )
  return userId ? accountPushHere(userId) : pushState() === 'granted' && readFlag(LINK_PUSH_KEY)
}

// ---------------------------------------------------------------------------
// Arriving from a notification
// ---------------------------------------------------------------------------

/** The note a tapped notification leaves; see `rememberOpen` in public/sw.js. */
const OPEN_CACHE = 'star-voting-open'
/** Older notes are taps nobody's app picked up. */
const OPEN_FRESH_MS = 2 * 60_000

/**
 * Take (and delete) a fresh destination left by a tapped notification.
 * `caches.has` first, since `caches.open` would create an empty cache.
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
 * Navigate to the poll a tapped notification is about. Three routes in, since
 * each fails somewhere: a message to an open window; the cached note on start
 * (iOS launches the installed app at its start page); and the note again on
 * returning to the foreground (a resumed app may miss the message). The note
 * is deleted either way, so one tap moves the reader once.
 */
export function useNotificationRoutes(): void {
  const navigate = useNavigate()
  useEffect(() => {
    let alive = true

    function go(path: string) {
      // Already there: don't add a duplicate history entry.
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
      // Consume the note too, or foregrounding later would act on it again.
      void takeNotificationPath()
      go(data.path)
    }

    function onVisible() {
      if (document.visibilityState === 'visible') void check()
    }

    void check()
    document.addEventListener('visibilitychange', onVisible)
    navigator.serviceWorker?.addEventListener('message', onMessage)
    // Worker messages queue until the page says it is listening.
    navigator.serviceWorker?.startMessages()
    return () => {
      alive = false
      document.removeEventListener('visibilitychange', onVisible)
      navigator.serviceWorker?.removeEventListener('message', onMessage)
    }
  }, [navigate])
}

// ---------------------------------------------------------------------------
// Banners dismissed for good
// ---------------------------------------------------------------------------

const BANNER_KEY = 'star-voting:app-banner-dismissed'

/** The install banner. */
export function appBannerDismissed(): boolean {
  return readFlag(BANNER_KEY)
}

export function dismissAppBanner(): void {
  writeFlag(BANNER_KEY, true)
}

/** The banner saying where the push switch is (`Banners`). */
const NOTIFY_HINT_KEY = 'star-voting:notify-hint-dismissed'

export function notifyHintDismissed(): boolean {
  return readFlag(NOTIFY_HINT_KEY)
}

export function dismissNotifyHint(): void {
  writeFlag(NOTIFY_HINT_KEY, true)
}
