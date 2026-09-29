import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Anchor, Stack, Switch, Text } from '@mantine/core'
import { supabase } from '../lib/supabase'
import {
  disableLinkPush,
  enableAccountPush,
  enableLinkPush,
  PushRefused,
  pushState,
  rememberAccountPush,
  usePushHere,
  type PushState,
} from '../lib/push'
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
 * is off and disabled, and that is the one case it carries a line under it:
 * which of those it is, and the way to the install guide, which says what to
 * do about each. A switch that is on or can be turned on needs no words, and
 * gets none, so the menu stays two lines for everybody it works for.
 *
 * Drawn by NotificationSwitches, which is the one place an account turns
 * notifications on. A reader holding a link gets LinkPushSwitch below, in the
 * same menu.
 */
export function PushSwitch({
  userId,
  settings,
  onChange,
}: {
  userId: string
  settings: NotificationSettings
  onChange: (next: NotificationSettings) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Read on every render rather than held: it changes when the browser's own
  // prompt is answered, which is inside the press below.
  const state = pushState()
  const capable = state === 'ask' || state === 'granted'
  const reason = reasonFor(state)

  async function toggle(on: boolean) {
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
      rememberAccountPush(on)
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
        description={reason}
        checked={capable && settings.push && settings.thisDevice}
        disabled={!capable || busy}
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

/**
 * Push for a reader with no account: the gear menu's one switch when nobody
 * is signed in. There is no account to keep a setting on and no email to
 * send, so this is the whole menu, and it answers for this browser only.
 *
 * On means every open poll answered here from now on is watched — the
 * browser hears when it opens for voting and when its results are ready — and
 * so is one already answered, the next time its page is open (OpenPollPanel
 * files it). Off takes all of those watches back. What a watch carries is
 * what Notify me's always did: an endpoint, and nothing saying who asked.
 *
 * Disabled with a reason, in the same words and for the same states as the
 * account's switch above.
 */
export function LinkPushSwitch() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const on = usePushHere(undefined)
  const state = pushState()
  const capable = state === 'ask' || state === 'granted'

  async function toggle(next: boolean) {
    setBusy(true)
    setError(null)
    try {
      if (next) await enableLinkPush()
      else await disableLinkPush()
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
        description={reasonFor(state)}
        checked={capable && on}
        disabled={!capable || busy}
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

/** Why a push switch cannot be turned on here, or nothing when it can. */
function reasonFor(state: PushState) {
  const guide = (
    <>
      {' '}
      <Anchor component={Link} to="/app" inherit>
        See how
      </Anchor>
    </>
  )

  return state === 'unconfigured' ? (
    'Not available on this site yet.'
  ) : state === 'needs-install' ? (
    <>On iPhone and iPad, install the app first.{guide}</>
  ) : state === 'unsupported' ? (
    <>This browser can&rsquo;t receive notifications.{guide}</>
  ) : state === 'denied' ? (
    <>Blocked in this browser&rsquo;s settings.{guide}</>
  ) : undefined
}
