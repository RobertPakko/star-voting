import { useState } from 'react'
import { Alert, Button } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { BellIcon, BellRingingIcon, BellSlashIcon, GearIcon } from '@phosphor-icons/react'
import { useAuth } from '../lib/auth'
import {
  canAskForPush,
  dismissNotifyHint,
  notifyHintDismissed,
  pushState,
  PushRefused,
  unwatchPoll,
  useAccountPushHere,
  useWatching,
  watchPoll,
} from '../lib/push'
import { AppBanner } from './AppBanner'

/** Which moment is next on a poll, which is what a button promises. */
type Stage = 'opening' | 'results'

function nextMoment(stage: Stage): string {
  return stage === 'opening' ? 'voting opens' : 'the results are ready'
}

/**
 * "Notify me" on an open poll, for whoever is holding its link.
 *
 * This is the reason push exists in this app at all: an open poll's voters
 * gave no address and need no account, so an email could never reach them,
 * and the only way to find out the result was to keep opening the link. One
 * press here asks the browser for permission and files a watch on the poll —
 * with nothing attached that says who asked; see 0072_push_notifications.sql
 * — and the browser hears when the poll opens for voting and when its
 * results are ready. Then the watch is gone.
 *
 * **A button and nothing else**, so that it can stand beside *Edit vote* on
 * the card a voter comes back to: two things this reader can do about their
 * vote, in one row. It is a toggle and says so on both sides — *Notify me*
 * with a bell, and once pressed *Turn off notifications* with the bell struck
 * through — because the second state used to be a quiet grey word under a
 * sentence, and read as a label rather than as the way back. A refusal is
 * said in a toast, since a line of red wedged into that row would push the
 * buttons apart.
 *
 * Where this browser cannot be asked — an iPhone in a Safari tab, most
 * commonly — it draws nothing, and the caller puts the banner under the card
 * instead (`canAskForPush`), because the answer there is "install the app
 * first", which is what the banner's guide says.
 */
export function WatchPoll({
  pollId,
  watchKey,
  stage,
}: {
  pollId: string
  /** What the poll is known by locally: its group, so every question agrees. */
  watchKey: string
  /** Which moment is next, which is what the button promises. */
  stage: Stage
}) {
  const watching = useWatching(watchKey)
  const [busy, setBusy] = useState(false)

  if (!canAskForPush()) return null

  const next = nextMoment(stage)

  async function toggle() {
    setBusy(true)
    try {
      if (watching) await unwatchPoll(pollId, watchKey)
      else await watchPoll(pollId, watchKey)
    } catch (caught) {
      notifications.show({
        color: 'red',
        message:
          caught instanceof PushRefused || caught instanceof Error
            ? caught.message
            : 'Something went wrong.',
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Button
      variant={watching ? 'default' : 'light'}
      leftSection={
        watching ? <BellSlashIcon size={16} aria-hidden /> : <BellIcon size={16} aria-hidden />
      }
      loading={busy}
      onClick={toggle}
      title={
        watching
          ? `This device will get a notification when ${next}.`
          : `Get a notification on this device when ${next}.`
      }
    >
      {watching ? 'Turn off notifications' : 'Notify me'}
    </Button>
  )
}

/**
 * What a signed-in reader is told where a reader holding a link would see
 * Notify me: under the card a voter lands on after voting, and after
 * confirming the options. Those are the two moments somebody is left waiting
 * on everybody else.
 *
 * It files nothing and offers no button. A signed-in reader already hears
 * about every poll they are in — an invite poll through its list, an open poll
 * through the account their ballot or confirmation carries — on whichever
 * channels their account allows, and the switches for those are
 * in the gear menu in the header. So the one thing this can usefully say is
 * where that menu is, and it says it only to a reader whose device is not
 * being pushed to yet: once push is on here there is nothing to say, and it
 * goes the moment the switch is turned on (`useAccountPushHere`), rather than
 * on the next page load.
 *
 * **A banner under the card rather than a line inside it**, in the shape of
 * AppBanner: the card is about this ballot, and this is about the account.
 * Closing it is for good, in this browser, for the reason AppBanner's is — a
 * reader who has decided against push on purpose should not be asked on every
 * poll they vote in.
 *
 * Where the device needs the app installed first — an iPhone in a Safari tab —
 * AppBanner stands in for it, as it does for WatchPoll; where the browser has
 * said no or has no push at all, or the build has none, it draws nothing.
 */
export function NotifyHint({ stage }: { stage: Stage }) {
  const { session } = useAuth()
  const userId = session?.user.id
  const pushHere = useAccountPushHere(userId)
  const [dismissed, setDismissed] = useState(notifyHintDismissed)

  if (!userId) return null
  if (pushState() === 'needs-install') return <AppBanner />
  if (!canAskForPush() || pushHere || dismissed) return null

  return (
    <Alert
      variant="light"
      icon={<BellRingingIcon size={20} aria-hidden />}
      withCloseButton
      closeButtonLabel="Dismiss for good"
      onClose={() => {
        dismissNotifyHint()
        setDismissed(true)
      }}
    >
      To be notified when {nextMoment(stage)}, turn on push notifications from the{' '}
      <GearIcon size={14} role="img" aria-label="gear" style={{ verticalAlign: '-2px' }} /> menu at
      the top of the page.
    </Alert>
  )
}
