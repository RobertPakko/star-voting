import { Anchor, AppShell, Button, Group, Text, Title } from '@mantine/core'
import { Link, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { InstallButton } from './InstallButton'
import { ThemeToggle } from './ThemeToggle'

/**
 * The app shell, wrapped around every page except the sign-in screen;
 * including the ones reachable without an account (the public voting page
 * and `/about`). A voter who arrives from a share link is looking at the
 * same site as everyone else and should see the same header: the earlier
 * signed-out version was a small wordmark inline with the content, which
 * read as part of the poll rather than as the site around it.
 *
 * Only the right-hand group changes with the session. The wordmark links
 * to `/` either way; the poll list signed in, the sign-in screen signed
 * out; which is where a wordmark in the top-left is expected to go.
 *
 * The About link is dropped while About is what's on screen: a link to the
 * page you are already reading is a dead end that still asks to be read,
 * and its absence is the plainest way to say you have arrived.
 */
export function Layout() {
  const { session } = useAuth()
  const { pathname } = useLocation()
  const onAbout = pathname === '/about'

  return (
    <AppShell header={{ height: 60 }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Link
            to="/"
            style={{
              textDecoration: 'none',
              color: 'inherit',
              minWidth: 0,
            }}
          >
            <Group component="span" gap="sm" wrap="nowrap">
              <img
                src={`${import.meta.env.BASE_URL}logo.png`}
                alt="logo"
                width={32}
                height={32}
                style={{ borderRadius: 8, display: 'block' }}
              />
              <Title order={3} size="h4">
                STAR Voting
              </Title>
            </Group>
          </Link>
          <Group gap="sm" wrap="nowrap">
            {session && (
              <Text size="sm" c="dimmed" visibleFrom="sm" truncate maw={240}>
                {session.user.email}
              </Text>
            )}
            {/* A plain link rather than a button: it's navigation, not an
                action, and the header has to hold the title without wrapping
                at 375px wide. */}
            {!onAbout && (
              <Anchor component={Link} to="/about" size="sm" style={{ whiteSpace: 'nowrap' }}>
                About
              </Anchor>
            )}
            <InstallButton />
            <ThemeToggle />
            {/* Signed out this is an offer rather than a gate; voting on an
                open poll needs no account; but it has to be visible to be
                taken, so it gets the same slot the sign-out button holds. */}
            {!session && (
              <Button component={Link} to="/" variant="outline" size="sm">
                Sign in
              </Button>
            )}
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  )
}
