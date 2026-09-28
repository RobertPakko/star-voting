import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Anchor, Button, Group, Stack, Text } from '@mantine/core'
import { BellIcon, BellSlashIcon } from '@phosphor-icons/react'
import { disableAccountPush, enableAccountPush, PushRefused, pushState } from '../lib/push'

/**
 * Push notifications on this device, for the signed-in account: whether it
 * gets them, and the one button that changes that.
 *
 * Drawn on the settings page and at the foot of the install guide, which are
 * the two places anybody goes to turn them on. Everything it can say is one of
 * the states in `pushState`, in the order a reader would have to deal with
 * them — install first on an iPhone, unblock in the browser if they said no —
 * and each one says what to do rather than only what is wrong.
 */
export function DevicePush({
  userId,
  bound,
  accountPush,
  onChange,
  guideLink = true,
}: {
  userId: string
  /** Whether this browser is one of the account's devices; null while unknown. */
  bound: boolean | null
  /** The account's own push setting: off means no device hears anything. */
  accountPush: boolean
  onChange: (bound: boolean) => void
  /** Whether to point at the install guide, which is pointless on the guide. */
  guideLink?: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Read on every render rather than held: it changes when the browser's own
  // prompt is answered, which is inside the press below.
  const state = pushState()

  const guide = guideLink ? (
    <>
      {' '}
      <Anchor component={Link} to="/app" inherit>
        See how
      </Anchor>
      .
    </>
  ) : null

  if (state === 'unconfigured') {
    return (
      <Text size="sm" c="dimmed">
        Push notifications are not available on this site yet.
      </Text>
    )
  }
  if (state === 'needs-install') {
    return (
      <Text size="sm" c="dimmed">
        On an iPhone or iPad, notifications only work once this site has been added to your Home
        Screen and opened from there.{guide}
      </Text>
    )
  }
  if (state === 'unsupported') {
    return (
      <Text size="sm" c="dimmed">
        This browser cannot receive push notifications.{guide}
      </Text>
    )
  }
  if (state === 'denied') {
    return (
      <Text size="sm" c="dimmed">
        Notifications are blocked for this site. Allow them in your browser or device settings, then
        come back here.{guide}
      </Text>
    )
  }

  async function toggle(on: boolean) {
    setBusy(true)
    setError(null)
    try {
      if (on) await enableAccountPush(userId)
      else await disableAccountPush()
      onChange(on)
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
    <Stack gap="xs">
      <Group justify="space-between" wrap="wrap" gap="sm">
        <Text size="sm" c="dimmed" style={{ flex: '1 1 16rem' }}>
          {!bound
            ? 'This device does not get notifications about your polls.'
            : accountPush
              ? 'This device gets notifications about your polls.'
              : 'This device is set up, but push notifications are turned off for your account.'}
        </Text>
        {bound ? (
          <Button
            variant="default"
            leftSection={<BellSlashIcon size={16} aria-hidden />}
            loading={busy}
            onClick={() => toggle(false)}
          >
            Turn off on this device
          </Button>
        ) : (
          <Button
            leftSection={<BellIcon size={16} aria-hidden />}
            loading={busy || bound === null}
            onClick={() => toggle(true)}
          >
            Turn on for this device
          </Button>
        )}
      </Group>
      {error && (
        <Text size="sm" c="red">
          {error}
        </Text>
      )}
    </Stack>
  )
}
