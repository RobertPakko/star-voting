import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Center, Loader, Stack, Text, Title } from '@mantine/core'
import { supabase } from '../lib/supabase'
import { voterKeyFor } from '../lib/voterKey'
import { OpenPollPanel } from '../components/OpenPollPanel'
import { PollTags } from '../components/PollTags'
import type { OpenPollView } from '../lib/types'

/**
 * The /p/:token route: an open poll seen by someone who is not signed in,
 * and may never be. It renders inside the ordinary app shell: landing here
 * is how plenty of people first meet the site, and the header is what tells
 * them there is a site, with the way to sign in on it.
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
      <Stack gap="xs" align="center" maw={720} mx="auto">
        <Title order={3}>Poll not found</Title>
        <Text c="dimmed" ta="center">
          This link may be mistyped, or the poll may have been deleted.
        </Text>
      </Stack>
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
    <Stack gap="lg" maw={720} mx="auto">
      <Stack gap={8}>
        <Title order={2}>{view.poll.title}</Title>
        {/* Someone arriving from a shared link has no other context at all,
            so all three terms of the poll are stated here, not just the one
            that changes what happens to their ballot. */}
        <PollTags
          mode={view.poll.mode}
          showVoters={view.poll.show_voters}
          showBallots={view.poll.show_ballots}
          closed={view.is_closed}
        />
        {view.poll.description && <Text c="dimmed">{view.poll.description}</Text>}
      </Stack>

      <OpenPollPanel token={token} />
    </Stack>
  )
}
