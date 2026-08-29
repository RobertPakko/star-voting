import { Alert } from '@mantine/core'
import type { LiveStatus } from '../lib/useLiveStream'

/**
 * That this page has stopped hearing about changes, and what to do about it.
 *
 * Live updates arrive over a websocket, and a websocket is the one part of
 * this app some networks will not carry — a corporate proxy or a captive
 * portal can pass every request the page makes and still refuse the socket.
 * The page still works in that case, which is the problem: it loads (see
 * `FIRST_READ_MS`), it shows a real poll, and then it quietly stops being
 * true.
 *
 * So this is the only thing on any of these pages that talks about how they
 * update. There is no live indicator anywhere, because a page that updates
 * itself demonstrates that by updating itself. A page that has *stopped*
 * demonstrates nothing, and is the one state a reader cannot work out by
 * looking.
 *
 * It says what to do rather than what went wrong: "reconnecting" invites
 * waiting, and waiting is the one thing that will not help on a network that
 * blocks websockets. Refreshing always works — every first read on every page
 * is an ordinary request. `useLiveStream` sits on this for several seconds
 * first, so a socket that drops and comes straight back never reaches here.
 */
export function LiveConnectionNotice({ status }: { status: LiveStatus }) {
  if (status !== 'offline') return null

  return (
    <Alert color="yellow" variant="light" title="Not receiving live updates">
      This page has lost its connection to the server, so updates will not appear on their own.
      Refresh the page manually to see new updates.
    </Alert>
  )
}
