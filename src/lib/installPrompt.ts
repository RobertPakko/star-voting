import { useCallback, useSyncExternalStore } from 'react'

/**
 * Chrome's install prompt, held until there is somewhere to put it.
 *
 * Chromium fires `beforeinstallprompt` when it has decided the app is
 * installable, cancels its own banner if you call `preventDefault`, and then
 * lets you open the same dialog later from a click of your own. The event is
 * the only handle on that dialog, and it arrives on its own schedule — often
 * before React has mounted — so it is caught here at module scope and kept.
 *
 * Nothing equivalent exists in Safari: iOS installs are Share → Add to Home
 * Screen and there is no API to ask. So `useInstallPrompt` returning null is
 * the ordinary case, not an error — on iOS, in an already-installed window,
 * and in every browser that has not made up its mind yet — and the button
 * that reads it renders nothing at all rather than instructions for a menu
 * the reader may not have.
 */
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

let pending: BeforeInstallPromptEvent | null = null
const subscribers = new Set<() => void>()

function announce() {
  for (const notify of subscribers) notify()
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault()
    pending = event as BeforeInstallPromptEvent
    announce()
  })

  // Installed from our button or from the browser's own menu, either way
  // there is nothing left to offer.
  window.addEventListener('appinstalled', () => {
    pending = null
    announce()
  })
}

function subscribe(notify: () => void) {
  subscribers.add(notify)
  return () => {
    subscribers.delete(notify)
  }
}

/**
 * A function that opens the browser's install dialog, or null when there is
 * no dialog to open.
 *
 * The event is spent by prompting with it — a second call throws — so it is
 * dropped as it is used, which also takes the button away.
 */
export function useInstallPrompt(): (() => void) | null {
  const event = useSyncExternalStore(
    subscribe,
    () => pending,
    // The server snapshot, which this app never renders, but useSyncExternalStore
    // asks for it and a stray `window` in a hook is how that stops being true.
    () => null,
  )

  const install = useCallback(() => {
    if (!event || event !== pending) return
    pending = null
    announce()
    void event.prompt()
  }, [event])

  return event ? install : null
}
