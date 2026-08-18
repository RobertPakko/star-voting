import { Anchor, Button, Group, Text } from '@mantine/core'
import { Link } from 'react-router-dom'
import { ThemeToggle } from './ThemeToggle'

/**
 * The header row for the two pages that render outside the app shell —
 * the public voting page and `/about` read signed-out. Neither has the
 * shell's header above it, so without this a voter who arrived from a
 * share link has no way out of the page they landed on.
 *
 * The wordmark is a link to the same place the button goes, because that
 * is where a wordmark in the top-left is expected to go, and it is the
 * only thing on the page that reads as "this site" rather than "this
 * poll". Signed out, `/` is the sign-in screen.
 */
export function PublicHeader({ showAbout = true }: { showAbout?: boolean }) {
  return (
    <Group justify="space-between" wrap="nowrap">
      <Anchor component={Link} to="/" underline="never" c="dimmed">
        <Text size="xs" c="dimmed" tt="uppercase" fw={700} style={{ whiteSpace: 'nowrap' }}>
          STAR Voting
        </Text>
      </Anchor>
      <Group gap="xs" wrap="nowrap">
        {/* Someone who has never signed in has no context for what they are
            being asked to do; the about page is the only thing that gives
            it to them. Omitted on the about page itself. */}
        {showAbout && (
          <Anchor component={Link} to="/about" size="sm" style={{ whiteSpace: 'nowrap' }}>
            About
          </Anchor>
        )}
        <ThemeToggle />
        {/* Spelled out as a button as well as the wordmark link: voting here
            needs no account, so signing in is an offer, not a gate, and an
            offer has to be visible to be taken. It still fits beside the
            rest of the row at 375px wide. */}
        <Button component={Link} to="/" variant="subtle" size="sm" style={{ whiteSpace: 'nowrap' }}>
          Sign in
        </Button>
      </Group>
    </Group>
  )
}
