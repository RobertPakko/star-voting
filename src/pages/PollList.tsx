import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Button, Card, Center, Group, Loader, Stack, Text, Title } from '@mantine/core'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import type { PollListItem } from '../lib/types'

export function PollList() {
  const { session } = useAuth()
  const [polls, setPolls] = useState<PollListItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    // One round trip for the polls and their status. This used to be a
    // select plus one poll_status RPC per poll.
    supabase.rpc('list_polls').then(({ data, error: rpcError }) => {
      if (cancelled) return
      if (rpcError) setError(rpcError.message)
      else setPolls((data as PollListItem[]) ?? [])
    })

    return () => {
      cancelled = true
    }
  }, [])

  if (error) {
    return (
      <Text c="red" ta="center">
        {error}
      </Text>
    )
  }

  if (!polls) {
    return (
      <Center py="xl">
        <Loader />
      </Center>
    )
  }

  return (
    <Stack gap="lg" maw={720} mx="auto">
      <Group justify="space-between">
        <Title order={2}>Your polls</Title>
        <Button component={Link} to="/polls/new">
          New poll
        </Button>
      </Group>

      {polls.length === 0 && (
        <Text c="dimmed" size="sm">
          No polls yet. Create one, or wait for an invite.
        </Text>
      )}

      <Stack gap="sm">
        {polls.map((poll) => (
          <Card
            key={poll.id}
            withBorder
            component={Link}
            to={`/polls/${poll.id}`}
            style={{ textDecoration: 'none' }}
          >
            <Stack gap={4}>
              <Text fw={600} c="var(--mantine-color-text)">
                {poll.title}
              </Text>
              {poll.description && (
                <Text size="sm" c="dimmed">
                  {poll.description}
                </Text>
              )}
              <Text size="xs" c="dimmed">
                {poll.created_by === session?.user.id
                  ? 'Created by you'
                  : `Created by ${poll.created_by_email}`}
              </Text>
              <Group gap="xs" mt={4}>
                <Badge color={poll.results_available ? 'green' : 'blue'} variant="light">
                  {poll.results_available
                    ? 'Results ready'
                    : poll.mode === 'open'
                      ? // No invite list, so no denominator to count towards.
                        `${poll.voted_count} ${poll.voted_count === 1 ? 'response' : 'responses'}`
                      : `${poll.voted_count}/${poll.invited_count} voted`}
                </Badge>
                {poll.mode === 'open' && (
                  <Badge color="grape" variant="light">
                    Open link
                  </Badge>
                )}
                {poll.is_closed && (
                  <Badge color="gray" variant="light">
                    Closed
                  </Badge>
                )}
                {/* `voted` is derived from the signed-in user's ballot, which
                    open polls never have -- it would always read "pending". */}
                {poll.mode === 'invite' && !poll.voted && !poll.results_available && !poll.is_closed && (
                  <Badge color="orange" variant="light">
                    Vote pending
                  </Badge>
                )}
              </Group>
            </Stack>
          </Card>
        ))}
      </Stack>
    </Stack>
  )
}
