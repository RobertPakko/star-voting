import { useSyncExternalStore } from 'react'

/**
 * Whether this browser reads times as `14:30` or as `2:30pm`.
 *
 * **Per browser, not per account**, like the sign-in method: which clock
 * somebody reads is a habit of the person holding the device, and keeping it
 * here costs no migration, no request, and nothing to wait for before the
 * first time on a page can be drawn. A reader who wants it everywhere turns it
 * on everywhere.
 *
 * **Off by default**, so a poll reads `2:30pm` until somebody asks otherwise.
 * It changes how a time is *written* and nothing else: every option is still
 * named in ISO 8601 and every cell of the grid is still keyed by `HH:mm`, so
 * the same poll is the same poll whichever clock is reading it. See
 * `formatTimeOfDay` in `schedule.ts`, which is the one place the two clocks
 * differ.
 */

const STORAGE_KEY = 'star-voting:24-hour-time'

function read(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'on'
  } catch {
    // Private browsing, or storage disabled. The default is the default.
    return false
  }
}

let current = read()
const subscribers = new Set<() => void>()

function announce() {
  for (const notify of subscribers) notify()
}

// Another tab flipping the switch: follow it, so two tabs of one browser never
// disagree about a setting that belongs to the browser.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY) return
    current = read()
    announce()
  })
}

function subscribe(notify: () => void) {
  subscribers.add(notify)
  return () => {
    subscribers.delete(notify)
  }
}

/** Turns the 24-hour clock on or off for this browser, and redraws every time on screen. */
export function set24HourTime(on: boolean): void {
  current = on
  try {
    localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off')
  } catch {
    // Kept for this tab, and back to the default on the next visit.
  }
  announce()
}

/** Whether this browser reads times on the 24-hour clock, live. */
export function use24HourTime(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => false,
  )
}
