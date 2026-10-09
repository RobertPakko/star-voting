import { Card, Stack, Title, VisuallyHidden } from '@mantine/core'
import { useAuth } from '../lib/auth'
import { ClockSwitch } from '../components/ClockSwitch'
import { NotificationSwitches } from '../components/NotificationSwitches'
import { Reveal } from '../components/Reveal'
import { SettingsSkeleton } from '../components/Skeletons'
import { usePageTitle } from '../lib/pageTitle'

/**
 * The /settings route: the two notification switches on a page of their own,
 * and the 24-hour clock switch the gear menu carries beside them.
 *
 * Nothing in the app links here. Inside the app the same switches are one
 * press away in the header's gear menu, which is lighter than a page and does
 * not take the reader off the poll they were reading. What needs an address is
 * the footer of every email — *change your notification settings* — because a
 * link cannot open a menu, and a reader who is not signed in is taken through
 * the sign-in screen and brought back here.
 */
export function Settings() {
  usePageTitle('Settings')
  const { session } = useAuth()

  if (!session) return <SettingsSkeleton />

  return (
    <Reveal>
      <Stack maw={720} mx="auto" gap="md">
        {/* The page's own heading, for a screen reader's outline; the two
            sections under it are what a sighted reader needs to see. */}
        <VisuallyHidden>
          <Title order={1}>Settings</Title>
        </VisuallyHidden>
        <Title order={2}>Notifications</Title>
        <Card withBorder>
          <NotificationSwitches userId={session.user.id} />
        </Card>
        <Title order={2}>Display</Title>
        <Card withBorder>
          <ClockSwitch />
        </Card>
      </Stack>
    </Reveal>
  )
}
