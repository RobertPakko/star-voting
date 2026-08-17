import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Anchor, Badge, Center, Container, Group, Loader, Stack, Text, Title } from '@mantine/core'
import { supabase } from '../lib/supabase'
import { voterKeyFor } from '../lib/voterKey'
import { OpenPollPanel } from '../components/OpenPollPanel'
import { ThemeToggle } from '../components/ThemeToggle'
import type { OpenPollView } from '../lib/types'

/**
 * The /p/:token route: an open poll seen by someone who is not signed in
 * and never will be. Deliberately outside the app shell — there is no
 * account here, so there is nothing to sign out of and no poll list to
 * navigate to.
 */
export function PublicPoll() {
  const { token } = useParams<{ token: string }>()
  const [view, setView] = useState<OpenPollView | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Fetched here too (cheaply) so the page can render the title and closed
  // badge around the panel, which owns the voting state itself.
  useEffect(() => {
    if (!token) return
    let cancelled = false
    supabase
      .rpc('open_poll_view', { p_token: token, p_voter_key: voterKeyFor(token) })
      .then(({ data, error: rpcError }) => {
        if (cancelled) return
        if (rpcError) setError(rpcError.message)
        else setView(data as OpenPollView)
      })
    return () => {
      cancelled = true
    }
  }, [token])

  if (!token || error) {
    return (
      <Container size="sm" py="xl">
        <Stack gap="xs" align="center">
          <Title order={3}>Poll not found</Title>
          <Text c="dimmed" ta="center">
            This link may be mistyped, or the poll may have been deleted.
          </Text>
        </Stack>
      </Container>
    )
  }

  if (!view) {
    return (
      <Center h="60vh">
        <Loader />
      </Center>
    )
  }

  return (
    <Container size="sm" py="xl">
      <Stack gap="lg">
        <Stack gap={4}>
          <Group justify="space-between" wrap="nowrap">
            <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
              STAR Voting
            </Text>
            <Group gap="xs" wrap="nowrap">
              {/* No account and no context: this is the only page that can
                  explain what they are about to be asked to do. */}
              <Anchor component={Link} to="/about" size="sm">
                About
              </Anchor>
              <ThemeToggle />
            </Group>
          </Group>
          <Group gap="xs">
            <Title order={2}>{view.poll.title}</Title>
            {/* Someone arriving from a shared link has no other context, so
                the one setting that decides what happens to their ballot
                after they cast it is said here as well as on the form. */}
            {view.poll.show_ballots && (
              <Badge color="teal" variant="light">
                Ballots published
              </Badge>
            )}
            {view.is_closed && (
              <Badge color="gray" variant="light">
                Closed
              </Badge>
            )}
          </Group>
          {view.poll.description && <Text c="dimmed">{view.poll.description}</Text>}
        </Stack>

        <OpenPollPanel token={token} />
      </Stack>
    </Container>
  )
}
