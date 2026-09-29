import { Card, Stack, Title } from '@mantine/core'
import { useAuth } from '../lib/auth'
import { NotificationSwitches } from '../components/NotificationSwitches'
import { Reveal } from '../components/Reveal'
import { SettingsSkeleton } from '../components/Skeletons'

/**
 * The /settings route: the two notification switches on a page of their own.
 *
 * Nothing in the app links here. Inside the app the same switches are one
 * press away in the header's gear menu, which is lighter than a page and does
 * not take the reader off the poll they were reading. What needs an address is
 * the footer of every email — *change your notification settings* — because a
 * link cannot open a menu, and a reader who is not signed in is taken through
 * the sign-in screen and brought back here.
 */
export function Settings() {
  const { session } = useAuth()

  if (!session) return <SettingsSkeleton />

  return (
    <Reveal>
      <Stack maw={720} mx="auto" gap="md">
        <Title order={2}>Notifications</Title>
        <Card withBorder>
          <NotificationSwitches userId={session.user.id} />
        </Card>
      </Stack>
    </Reveal>
  )
}
