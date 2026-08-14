import { AppShell, Button, Group, Text, Title } from '@mantine/core'
import { Link, Outlet } from 'react-router-dom'
import { useAuth } from '../lib/auth'

export function Layout() {
  const { session, signOut } = useAuth()

  return (
    <AppShell header={{ height: 60 }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Link to="/" style={{ textDecoration: 'none', color: 'inherit' }}>
            <Title order={3}>STAR Voting</Title>
          </Link>
          <Group gap="md">
            <Text size="sm" c="dimmed">
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
