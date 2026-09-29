import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Button, Group, Stack, Text } from '@mantine/core'
import { BellIcon } from '@phosphor-icons/react'
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
 * "Notify me" on an invite poll, for the account reading it.
 *
 * The same button WatchPoll draws, in the same places — under the card a voter
 * lands on after voting, and after confirming the options — but it files
 * nothing. An invite poll already tells everybody on its list about every
 * moment, by email and by push, as their account's settings say; what a
 * reader here is missing is only push being on for this device, and that is
 * one switch that belongs to the account rather than to this poll. So the
 * button takes them to it, with the way back to this poll on the page.
 *
 * Where there is nothing the switch could do — an iPhone outside the
 * installed app — the banner stands in for it, as it does for WatchPoll; and
 * where this device is already bound to the account, or the browser has said
 * no, or the build has no push at all, it draws nothing.
 */
export function NotifyInSettings({ stage }: { stage: Stage }) {
  const { session } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const userId = session?.user.id

  if (!userId) return null
  if (pushState() === 'needs-install') return <AppBanner />
  if (!canAskForPush() || accountPushHere(userId)) return null

  return (
    <Group justify="flex-end">
      <Button
        variant="light"
        leftSection={<BellIcon size={16} aria-hidden />}
        onClick={() => navigate('/settings', { state: { from: location.pathname } })}
      >
        Notify me when {nextMoment(stage)}
      </Button>
    </Group>
  )
}
