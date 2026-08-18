import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Button, Card, Center, Group, Loader, Stack, Text, Title } from '@mantine/core'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { useLiveRefresh } from '../lib/useLiveRefresh'
import { LiveIndicator } from '../components/LiveIndicator'
import { PollTags } from '../components/PollTags'
import { badgeColor, countBadge } from '../lib/badgeColors'
import type { PollListItem } from '../lib/types'

export function PollList() {
  const { session } = useAuth()
  const [polls, setPolls] = useState<PollListItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Whether a read has ever come back; see the note in PublicPoll.
  const loaded = useRef(false)

  // One round trip for the polls and their status. This used to be a
  // select plus one poll_status RPC per poll -- which is also what makes it
  // cheap enough to re-read on a timer.
  const load = useCallback(async () => {
    const { data, error: rpcError } = await supabase.rpc('list_polls')
    if (rpcError) {
      // A refresh that fails keeps the list already on screen; only a first
      // read that fails leaves nothing to show.
      if (!loaded.current) setError(rpcError.message)
      return
    }
    loaded.current = true
    // Clears an error from a first read that failed: this page keeps
    // polling either way, so a connection that comes back brings the list
    // with it instead of leaving the reader looking at a dead end.
    setError(null)
    setPolls((data as PollListItem[]) ?? [])
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Unlike a single poll, a list has no settled state to stop at: any poll
  // on it can take a vote, and a new invite can add a row. It stays live for
  // as long as the tab is in front of someone.
  const { paused } = useLiveRefresh(load)

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
        <Group gap="sm">
          <Title order={2}>Your polls</Title>
          {/* Turnout on every card below moves on its own, so the page says
              so once, here, rather than putting a dot on each count. */}
          <LiveIndicator paused={paused} />
        </Group>
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
              {/* Where the poll has got to, kept on its own line so it can't
                  be confused with the settings row underneath. */}
              <Group gap="xs" mt={4}>
                <Badge
                  {...(poll.results_available
                    ? { color: badgeColor.done, variant: 'light' as const }
                    : countBadge)}
                >
                  {poll.results_available
                    ? 'Results ready'
                    : poll.mode === 'open'
                      ? // No invite list, so no denominator to count towards.
                        `${poll.voted_count} ${poll.voted_count === 1 ? 'response' : 'responses'}`
                      : `${poll.voted_count}/${poll.invited_count} voted`}
                </Badge>
                {/* `voted` is derived from the signed-in user's ballot, which
                    open polls never have -- it would always read "pending". */}
                {poll.mode === 'invite' && !poll.voted && !poll.results_available && !poll.is_closed && (
                  <Badge color={badgeColor.outstanding} variant="light">
                    Vote pending
                  </Badge>
                )}
              </Group>

              {/* The terms of the poll, in the same three tags and the same
                  words as the poll page itself. */}
              <PollTags
                mode={poll.mode}
                showVoters={poll.show_voters}
                showBallots={poll.show_ballots}
                closed={poll.is_closed}
              />
            </Stack>
          </Card>
        ))}
      </Stack>
    </Stack>
  )
}
