import { useState } from 'react'
import { Button, Group, Stack, Text } from '@mantine/core'
import { BellIcon, GearIcon } from '@phosphor-icons/react'
import { useAuth } from '../lib/auth'
import {
  accountPushHere,
  canAskForPush,
  pushState,
  PushRefused,
  unwatchPoll,
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
 * Where this browser cannot be asked — an iPhone in a Safari tab, most
 * commonly — the banner stands in for it, because the answer there is "install
 * the app first", which is what the banner's guide says.
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
  const [error, setError] = useState<string | null>(null)

  if (!canAskForPush()) return <AppBanner />

  const next = nextMoment(stage)

  async function toggle() {
    setBusy(true)
    setError(null)
    try {
      if (watching) await unwatchPoll(pollId, watchKey)
      else await watchPoll(pollId, watchKey)
    } catch (caught) {
      setError(
        caught instanceof PushRefused || caught instanceof Error
          ? caught.message
          : 'Something went wrong.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Stack gap={4}>
      <Group justify="space-between" wrap="wrap" gap="sm">
        {watching && (
          <Text size="sm" c="dimmed" style={{ flex: '1 1 14rem' }}>
            This device will get a notification when {next}.
          </Text>
        )}
        <Button
          variant={watching ? 'subtle' : 'light'}
          color={watching ? 'gray' : undefined}
          leftSection={watching ? undefined : <BellIcon size={16} aria-hidden />}
          loading={busy}
          onClick={toggle}
          style={{ marginLeft: 'auto' }}
        >
          {watching ? 'Stop notifications' : `Notify me when ${next}`}
        </Button>
      </Group>
      {error && (
        <Text size="sm" c="red">
          {error}
        </Text>
      )}
    </Stack>
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
 * being pushed to yet: once push is on here there is nothing to say, and a
 * line confirming it on every poll would be clutter on a question most people
 * answer once.
 *
 * Where the device needs the app installed first — an iPhone in a Safari tab —
 * the banner stands in for it, as it does for WatchPoll; where the browser has
 * said no or has no push at all, or the build has none, it draws nothing.
 */
export function NotifyHint({ stage }: { stage: Stage }) {
  const { session } = useAuth()
  const userId = session?.user.id

  if (!userId) return null
  if (pushState() === 'needs-install') return <AppBanner />
  if (!canAskForPush() || accountPushHere(userId)) return null

  return (
    <Text size="sm" c="dimmed">
      To be notified when {nextMoment(stage)}, turn notifications on from the{' '}
      <GearIcon size={14} role="img" aria-label="gear" style={{ verticalAlign: '-2px' }} /> menu at
      the top of the page.
    </Text>
  )
}
