import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Group, Stack, Text, Title } from '@mantine/core'
import { supabase } from '../lib/supabase'
import { voterKeyFor } from '../lib/voterKey'
import { useLiveRefresh } from '../lib/useLiveRefresh'
import { OpenPollPanel } from '../components/OpenPollPanel'
import { PollStateBadge, PollTags } from '../components/PollTags'
import { PollPageSkeleton } from '../components/Skeletons'
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

  if (!view) return <PollPageSkeleton />

  return (
    <Stack gap="lg" maw={720} mx="auto">
      {/* The same header the signed-in poll page shows, for the same reason
          it shows it: one poll should not be two different-looking things
          depending on how you reached it. */}
      <Stack gap={8}>
        <Group justify="space-between" wrap="nowrap" align="flex-start" gap="sm">
          <Title order={2}>{view.poll.title}</Title>
          {/* No winner's name here: naming it needs poll_winners(), which is
              for signed-in readers, and this page has no account behind it.
              The badge says the results are ready and the tally underneath
              says what they were -- see PollStateBadge on why that state is
              a real one rather than a fallback. */}
          <PollStateBadge
            soliciting={view.soliciting}
            resultsAvailable={view.results_available}
            closed={view.is_closed}
          />
        </Group>
        {/* Someone arriving from a shared link has no other context at all,
            so the terms of the poll are stated here, not just the one that
            changes what happens to their ballot.

            Turnout is the exception, and is held back until this browser has
            voted. Everywhere else the count is a click away on the reader's
            own poll list; here the link is the whole of their access, so
            putting it above a blank ballot would be the one screen that
            tells a voter how it is going before they vote. */}
        <PollTags
          mode={view.poll.mode}
          showVoters={view.poll.show_voters}
          showBallots={view.poll.show_ballots}
          turnout={
            view.voted || view.results_available
              ? {
                  soliciting: view.soliciting,
                  mode: view.poll.mode,
                  votedCount: view.voted_count,
                  invitedCount: 0,
                  optionCount: view.options.length,
                }
              : undefined
          }
        />
        {view.poll.description && <Text c="dimmed">{view.poll.description}</Text>}
      </Stack>

      <OpenPollPanel token={token} view={view} onChanged={load} />
    </Stack>
  )
}
