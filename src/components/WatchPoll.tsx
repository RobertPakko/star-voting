import { useState } from 'react'
import { Button, Group, Stack, Text } from '@mantine/core'
import { BellIcon } from '@phosphor-icons/react'
import { canAskForPush, PushRefused, unwatchPoll, useWatching, watchPoll } from '../lib/push'
import { AppBanner } from './AppBanner'

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
  stage: 'opening' | 'results'
}) {
  const watching = useWatching(watchKey)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!canAskForPush()) return <AppBanner />

  const next = stage === 'opening' ? 'voting opens' : 'the results are ready'

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
