import { Card, Stack, Switch, Text, Title } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { useNotificationSettings, type NotificationSettings } from '../lib/notificationSettings'
import { PushSwitch } from '../components/PushSwitch'
import { Reveal } from '../components/Reveal'
import { SettingsSkeleton } from '../components/Skeletons'

/**
 * The /settings route: how an account hears about its polls.
 *
 * Two switches. A poll tells its people about three moments — being
 * invited, voting opening, the results being ready — and the switches say
 * which channels those arrive on: email, push, both, or neither. Email is the
 * account's alone. Push is the account's too, but a push subscription belongs
 * to one browser on one device, so its switch also answers for the device in
 * the reader's hand; see PushSwitch.
 *
 * Neither switch reaches the sign-in email, which is not a notification about
 * a poll and without which nobody could get back in to turn email on again.
 *
 * The switches save as they are flipped, the way a phone's settings do: there
 * is nothing else on the page to be saved alongside them, and a Save button
 * under two switches is a button people forget to press.
 */
export function Settings() {
  const { session } = useAuth()
  const userId = session?.user.id ?? null
  const { settings, setSettings, error } = useNotificationSettings(userId)

  if (error) {
    return (
      <Text c="red" ta="center">
        {error}
      </Text>
    )
  }

  if (!session || !settings) return <SettingsSkeleton />

  async function save(next: NotificationSettings) {
    const previous = settings
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
    <Reveal>
      <Stack maw={720} mx="auto" gap="md">
        <Title order={2}>Settings</Title>

        <Card withBorder>
          <Stack gap="md">
            <Stack gap={4}>
              <Title order={4}>Notifications</Title>
              <Text size="sm" c="dimmed">
                You&rsquo;re told when you&rsquo;re invited to a poll, when a poll you&rsquo;re in
                opens for voting, and when its results are ready. Choose how.
              </Text>
            </Stack>

            <Switch
              label="Email"
              description={`Sent to ${session.user.email}. Sign-in emails are always sent.`}
              checked={settings.email}
              onChange={(event) => save({ ...settings, email: event.currentTarget.checked })}
            />
            <PushSwitch userId={session.user.id} settings={settings} onChange={setSettings} />
          </Stack>
        </Card>

        <Text size="sm" c="dimmed">
          Polls you answer through a link without signing in are not affected by these settings. To
          hear about one of those, press <em>Notify me</em> on the poll after you vote.
        </Text>
      </Stack>
    </Reveal>
  )
}
