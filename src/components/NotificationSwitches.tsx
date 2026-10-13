import { Stack, Switch, Text } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { supabase } from '../lib/supabase'
import {
  SWITCH_LABELS,
  useNotificationSettings,
  type NotificationSettings,
} from '../lib/notificationSettings'
import { ClockSwitch } from './ClockSwitch'
import { PushSwitch } from './PushSwitch'
import { SwitchesSkeleton } from './Skeletons'

/**
 * How an account hears about its polls: two switches, and nothing else.
 *
 * A poll tells its people about three moments — being invited, voting
 * opening, the results being ready — and the switches say which channels
 * those arrive on. Email is the account's alone; push is the account's too,
 * but a subscription belongs to one browser, so its switch also answers for
 * the device in the reader's hand (see PushSwitch). Neither reaches the
 * sign-in email, which is not a notification about a poll.
 *
 * Drawn in two places, and they are the same component so that they cannot
 * come to say different things: the gear menu in the header, which is how
 * anybody using the app gets to them, and the /settings page, which is where
 * the footer of every email points. The settings are read when this mounts —
 * which for the menu is when it is opened, so a page that nobody opens the
 * menu on costs nothing.
 *
 * The switches save as they are flipped, the way a phone's settings do: a
 * Save button under two switches is a button people forget to press.
 *
 * `withClock` draws the 24-hour switch under them, which is how the gear menu
 * holds all three. That switch reads nothing and could be drawn at once, but
 * the menu is one list of switches and should arrive as one: two rows of
 * skeleton above a row already settled read as a menu half broken. The
 * settings page keeps it in a card of its own, so it asks for two.
 */
export function NotificationSwitches({
  userId,
  withClock = false,
}: {
  userId: string
  withClock?: boolean
}) {
  const { settings, setSettings, error } = useNotificationSettings(userId)

  if (error) {
    return (
      <Text role="alert" size="sm" c="red">
        {error}
      </Text>
    )
  }

  if (!settings)
    return (
      <SwitchesSkeleton
        labels={[
          SWITCH_LABELS.email,
          SWITCH_LABELS.push,
          ...(withClock ? [SWITCH_LABELS.clock] : []),
        ]}
      />
    )

  async function saveEmail(email: boolean) {
    if (!settings) return
    const previous = settings
    const next: NotificationSettings = { ...settings, email }
    setSettings(next)
    const { error: saveError } = await supabase.rpc('set_notification_settings', {
      p_email: next.email,
      p_push: next.push,
    })
    if (saveError) {
      setSettings(previous)
      notifications.show({ message: saveError.message, color: 'red' })
    }
  }

  return (
    <Stack gap="sm">
      <Switch
        label={SWITCH_LABELS.email}
        checked={settings.email}
        onChange={(event) => saveEmail(event.currentTarget.checked)}
      />
      <PushSwitch userId={userId} settings={settings} onChange={setSettings} />
      {withClock && <ClockSwitch />}
    </Stack>
  )
}
