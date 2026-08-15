import { AppShell, Button, Group, Text, Title } from '@mantine/core'
import { Link, Outlet } from 'react-router-dom'
import { useAuth } from '../lib/auth'

export function Layout() {
  const { session, signOut } = useAuth()

  return (
    <AppShell header={{ height: 60 }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Link to="/" style={{ textDecoration: 'none', color: 'inherit', minWidth: 0 }}>
            <Title order={3} size="h4">
              STAR Voting
            </Title>
          </Link>
          <Group gap="sm" wrap="nowrap">
            <Text size="sm" c="dimmed" visibleFrom="sm" truncate maw={240}>
              {session?.user.email}
            </Text>
            <Button variant="subtle" size="sm" onClick={() => signOut()}>
              Sign out
            </Button>
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  )
}
