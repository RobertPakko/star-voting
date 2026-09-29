import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Anchor, Stack, Switch, Text } from '@mantine/core'
import { supabase } from '../lib/supabase'
import { enableAccountPush, PushRefused, pushState } from '../lib/push'
import type { NotificationSettings } from '../lib/notificationSettings'

/**
 * Push notifications for the signed-in account, as one switch.
 *
 * There used to be two: an account-wide switch, and a "this device" control
 * under it with a button of its own — because a push subscription belongs to
 * one browser on one device, and only that browser can make one. Two controls
 * for one question read as two questions, so they are folded together, and
 * the one switch answers for the device in the reader's hand:
 *
 * - **On** is push turned on for the account *and* this device receiving it.
 *   Turning it on asks the browser for permission, binds this device, and
 *   turns the account's push on — so it is also how a second device is added.
 * - **Off** turns the account's push off, which stops it everywhere. The
 *   devices stay bound, so turning it back on anywhere brings them all back.
 *
 * Where this device cannot receive a push at all — an iPhone outside the
 * installed app, a browser that said no, a browser with no push — the switch
 * is off and disabled, and the line under it says what to do instead.
 *
 * Drawn on the settings page, which is the one place an account turns
 * notifications on; a reader holding a link turns them on per poll instead,
 * with WatchPoll.
 */
export function PushSwitch({
  userId,
  settings,
  onChange,
}: {
  userId: string
  settings: NotificationSettings | null
  onChange: (next: NotificationSettings) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Read on every render rather than held: it changes when the browser's own
  // prompt is answered, which is inside the press below.
  const state = pushState()
  const capable = state === 'ask' || state === 'granted'

  const guide = (
    <>
      {' '}
      <Anchor component={Link} to="/app" inherit>
        See how
      </Anchor>
      .
    </>
  )

  const description =
    state === 'unconfigured' ? (
      'Push notifications are not available on this site yet.'
    ) : state === 'needs-install' ? (
      <>On an iPhone or iPad, notifications work once the app is on your Home Screen.{guide}</>
    ) : state === 'unsupported' ? (
      <>This browser cannot receive notifications.{guide}</>
    ) : state === 'denied' ? (
      <>Notifications are blocked for this site in your browser&rsquo;s settings.{guide}</>
    ) : (
      'Sent to each device where you turn this on.'
    )

  async function toggle(on: boolean) {
    if (!settings) return
    setBusy(true)
    setError(null)
    try {
      // Permission first, while the press still counts as a press: Safari
      // only shows the prompt from inside a gesture. See lib/push.ts.
      if (on) await enableAccountPush(userId)
      if (settings.push !== on) {
        const { error: saveError } = await supabase.rpc('set_notification_settings', {
          p_email: settings.email,
          p_push: on,
        })
        if (saveError) throw new Error(saveError.message)
      }
      onChange({ ...settings, push: on, thisDevice: on ? true : settings.thisDevice })
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
      <Switch
        label="Push notifications"
        description={description}
        checked={capable && !!settings?.push && !!settings.thisDevice}
        disabled={!capable || !settings || busy}
        onChange={(event) => toggle(event.currentTarget.checked)}
      />
      {error && (
        <Text size="sm" c="red">
          {error}
        </Text>
      )}
    </Stack>
  )
}
