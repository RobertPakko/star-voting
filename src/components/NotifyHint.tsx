import { useState } from 'react'
import { Alert, Stack } from '@mantine/core'
import { BellRingingIcon, GearIcon } from '@phosphor-icons/react'
import { useAuth } from '../lib/auth'
import { canAskForPush, dismissNotifyHint, notifyHintDismissed, usePushHere } from '../lib/push'
import { AppBanner } from './AppBanner'

/** Which moment is next on a poll, which is what the banner promises. */
type Stage = 'opening' | 'results'

function nextMoment(stage: Stage): string {
  return stage === 'opening' ? 'voting opens' : 'the results are ready'
}

/**
 * What stands under the card a reader is left waiting on — after voting, and
 * after confirming the options — which are the two moments somebody is
 * waiting on everybody else, and so the moments "we can tell you" and "this
 * can live on your home screen" are worth reading.
 *
 * Two banners, each only while it has something to say:
 *
 * - **Where the push switch is** (`PushHint`), to anybody whose device could
 *   be pushed to and is not yet.
 * - **That the site installs as an app** (`AppBanner`, the install wording),
 *   to anybody not already in it.
 *
 * **The same for every reader**, signed in or holding a link. There used to be
 * a Notify me button per poll for a link and a line pointing at the gear for
 * an account; both now turn push on from the gear, which files a watch on
 * every open poll a signed-out reader answers here (see OpenPollPanel), so
 * there is one place to look and one sentence saying where.
 */
export function WhileYouWait({ stage }: { stage: Stage }) {
  return (
    <Stack gap="md">
      <PushHint stage={stage} />
      <AppBanner topic="install" />
    </Stack>
  )
}

/**
 * The gear menu's whereabouts, until push is on here. It goes the moment the
 * switch is turned on (`usePushHere`), rather than on the next page load.
 *
 * Closing it is for good, in this browser, for the reason AppBanner's is — a
 * reader who has decided against push on purpose should not be asked on every
 * poll they vote in. Where the browser cannot be asked at all — an iPhone in a
 * Safari tab, a browser that said no, a build with no push — it draws
 * nothing; the install banner beside it covers the iPhone.
 */
function PushHint({ stage }: { stage: Stage }) {
  const { session } = useAuth()
  const pushHere = usePushHere(session?.user.id)
  const [dismissed, setDismissed] = useState(notifyHintDismissed)

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
