import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Center, Loader, Stack, Text, Title } from '@mantine/core'
import { supabase } from '../lib/supabase'
import { voterKeyFor } from '../lib/voterKey'
import { useLiveRefresh } from '../lib/useLiveRefresh'
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
  // Whether a read has ever come back, so a refresh that fails can be told
  // apart from a first read that did. A ref rather than `view` itself,
  // which would put the poll in load()'s dependencies.
  const loaded = useRef(false)

  // The whole poll, read once here and handed to the panel below: this page
  // needs the title and the tags, the panel needs everything else, and one
  // copy refreshed on one clock is what keeps them agreeing.
  const load = useCallback(async () => {
    if (!token) return
    const { data, error: rpcError } = await supabase.rpc('open_poll_view', {
      p_token: token,
      p_voter_key: voterKeyFor(token),
    })
    if (rpcError) {
      // Only a first read that fails says anything about the link. A later
      // one keeps the poll already on screen -- turning a page somebody has
      // been voting on into "poll not found" because one request lost a
      // race with a flaky connection would be a lie about their link.
      if (!loaded.current) setError(rpcError.message)
      return
    }
    loaded.current = true
    setView(data as OpenPollView)
  }, [token])

  useEffect(() => {
    load()
  }, [load])

  // A closed poll takes no more votes, and one whose results are out has
  // stopped moving, so the refreshing stops with it.
  const live = !!view && !view.is_closed && !view.results_available
  useLiveRefresh(load, { enabled: live })

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

      <OpenPollPanel token={token} view={view} onVoted={load} />
    </Stack>
  )
}
