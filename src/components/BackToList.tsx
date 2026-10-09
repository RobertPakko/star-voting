import { Button } from '@mantine/core'
import { ArrowLeftIcon } from '@phosphor-icons/react'
import { Link } from 'react-router-dom'
import { headingIn, launchFlight } from '../lib/headingFlight'

/**
 * The way back to the list, on a poll that was opened from it.
 *
 * Only there: a poll arrived at from a link — a chat, an email, a QR code —
 * was never on a list from the reader's point of view, and a control offering
 * to take them back to one would be a control to somewhere they have not been.
 * The wordmark in the header still goes to the list from anywhere.
 *
 * Pressing it flies the poll's heading back down onto its card, the opening
 * flight in reverse, and the list is drawn as it was left — the same page,
 * scrolled to the same place — from what it kept on the way out. See
 * lib/headingFlight.ts and lib/listCache.ts.
 *
 * It goes *to* the list rather than *back* through the history: a reader who
 * has walked through three of a poll's questions has three entries between
 * them and the list, and "back" would be the question before.
 */
export function BackToList({ listId }: { listId: string }) {
  return (
    <Button
      component={Link}
      to="/"
      variant="subtle"
      color="gray"
      size="compact-sm"
      leftSection={<ArrowLeftIcon size={16} aria-hidden />}
      mb="sm"
      onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
          return
        launchFlight('list', listId, headingIn(document, 'page'))
      }}
    >
      Your polls
    </Button>
  )
}
