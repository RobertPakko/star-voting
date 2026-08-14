import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Badge,
  Button,
  Card,
  Center,
  Group,
  Loader,
  Stack,
  Text,
  Title,
} from '@mantine/core'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import type { Poll, PollStatus } from '../lib/types'

interface PollRow extends Poll {
  status: PollStatus | null
}

export function PollList() {
  const { session } = useAuth()
  const [polls, setPolls] = useState<PollRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      const { data: pollRows, error: pollError } = await supabase
        .from('polls')
        .select('*')
        .order('created_at', { ascending: false })

      if (pollError) {
        if (!cancelled) setError(pollError.message)
        return
      }

      const withStatus = await Promise.all(
        (pollRows ?? []).map(async (poll) => {
          const { data } = await supabase.rpc('poll_status', { p_poll_id: poll.id }).single()
          return { ...poll, status: (data as PollStatus) ?? null }
        }),
      )

      if (!cancelled) setPolls(withStatus)
    }

    load()
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

  const created = polls.filter((p) => p.created_by === session?.user.id)
  const invited = polls.filter((p) => p.created_by !== session?.user.id)

  return (
    <Stack gap="xl" maw={720} mx="auto">
      <Group justify="space-between">
        <Title order={2}>Your polls</Title>
        <Button component={Link} to="/polls/new">
          New poll
        </Button>
      </Group>

      <PollSection title="Created by you" polls={created} emptyText="You haven't created any polls yet." />
      <PollSection title="Invited to" polls={invited} emptyText="No polls have been shared with you yet." />
    </Stack>
  )
}

function PollSection({
  title,
  polls,
  emptyText,
}: {
  title: string
  polls: PollRow[]
  emptyText: string
}) {
  return (
    <Stack gap="sm">
      <Title order={4}>{title}</Title>
      {polls.length === 0 && (
        <Text c="dimmed" size="sm">
          {emptyText}
        </Text>
      )}
      {polls.map((poll) => (
        <Card key={poll.id} withBorder component={Link} to={`/polls/${poll.id}`} style={{ textDecoration: 'none' }}>
          <Group justify="space-between">
            <div>
              <Text fw={600} c="var(--mantine-color-text)">
                {poll.title}
              </Text>
              {poll.description && (
                <Text size="sm" c="dimmed">
                  {poll.description}
                </Text>
              )}
            </div>
            {poll.status && (
              <Stack gap={4} align="flex-end">
                <Badge color={poll.status.is_complete ? 'green' : 'blue'} variant="light">
                  {poll.status.is_complete ? 'Results ready' : `${poll.status.voted_count}/${poll.status.invited_count} voted`}
                </Badge>
                {!poll.status.voted && !poll.status.is_complete && (
                  <Badge color="orange" variant="light">
                    Vote pending
                  </Badge>
                )}
              </Stack>
            )}
          </Group>
        </Card>
      ))}
    </Stack>
  )
}
