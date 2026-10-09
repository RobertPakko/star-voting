import { useEffect } from 'react'
import { shortPollId } from './pollId'

/**
 * The installed app's icon badge, from the page's side.
 *
 * The service worker sets it: it is the number of notifications still showing,
 * which is one per poll with news the reader has not opened (see
 * `updateBadge` in public/sw.js). What the page adds is the other half of
 * "unread" — opening the poll is reading it. So a poll page closes its own
 * notifications, which takes the poll off the badge and out of the
 * notification tray together, and the two stay one answer.
 *
 * A notification's tag is the short spelling of its poll's first question
 * (`push_message` in the schema), and a poll page knows every question of
 * its group, so any question of a poll clears the poll.
 */
export async function clearPollNotifications(pollIds: string[]): Promise<void> {
  if (!('serviceWorker' in navigator) || pollIds.length === 0) return
  try {
    const registration = await navigator.serviceWorker.getRegistration()
    if (!registration) return
    const tags = new Set(pollIds.map(shortPollId))
    const showing = await registration.getNotifications()
    let left = showing.length
    for (const notification of showing) {
      if (tags.has(notification.tag)) {
        notification.close()
        left--
      }
    }
    if (left === showing.length || !('setAppBadge' in navigator)) return
    if (left > 0) await navigator.setAppBadge(left)
    else await navigator.clearAppBadge()
  } catch {
    // No worker, no permission to list, no badge: nothing that can be fixed
    // from here, and nothing on the page depends on it.
  }
}

/**
 * Clears a poll's notifications while its page is open: on arriving, and again
 * whenever the page comes back to the foreground, since a notification that
 * arrives while the reader is looking at the poll it is about is news they
 * already have. The ids are joined into one key so a re-render handing over
 * an equal list does not count as a change.
 */
export function useClearPollNotifications(pollIds: string[]): void {
  const key = pollIds.join(',')
  useEffect(() => {
    if (!key) return
    const ids = key.split(',')
    void clearPollNotifications(ids)
    function onVisible() {
      if (document.visibilityState === 'visible') void clearPollNotifications(ids)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [key])
}
