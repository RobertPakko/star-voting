import { Button } from '@mantine/core'
import { ArrowLeftIcon } from '@phosphor-icons/react'
import { Link } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { headingIn, launchFlight } from '../lib/headingFlight'
import { readListSnapshot } from '../lib/listCache'

/**
 * The way back to the list, on every poll page of a reader who has a list.
 *
 * It was only on a poll opened from the list for a while, on the argument that
 * a poll arrived at from a link had never been on a list from the reader's
 * side of it. That was true and beside the point: the wordmark in the header
 * was the only other way to the list, and a wordmark is not something every
 * reader thinks to press. A control that is always there also keeps the top of
 * the page one shape, which is what lets the skeleton and the heading's flight
 * know where everything below it will be.
 *
 * Pressing it flies the poll's heading back down onto its card, the opening
 * flight in reverse, and the list is drawn as it was left — the same page,
 * scrolled to the same place — from what it kept on the way out. That needs a
 * list kept from earlier in this visit, so a poll the reader came to straight
 * from a link goes to the list the ordinary way, as does a poll that is not on
 * it. See lib/headingFlight.ts and lib/listCache.ts.
 *
 * It goes *to* the list rather than *back* through the history: a reader who
 * has walked through three of a poll's questions has three entries between
 * them and the list, and "back" would be the question before.
 */
export function BackToList({ listId }: { listId?: string }) {
  const { session } = useAuth()
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
        if (listId && readListSnapshot(session?.user.id))
          launchFlight('list', listId, headingIn(document, 'page'))
      }}
    >
      Your polls
    </Button>
  )
}
