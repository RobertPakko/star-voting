import { useEffect, useState } from 'react'
import { Card, Group, Stack, Table, Text, Title } from '@mantine/core'
import { supabase } from '../lib/supabase'
import { recall, remember } from '../lib/settled'
import { BallotsSkeleton } from './Skeletons'
import type { BallotSheet } from '../lib/types'

/**
 * Which ballot endpoint to read. Same split as ResultsSource, and for the
 * same reason: a session proves the caller's right to an invite poll, the
 * share token proves it for an open one.
 */
export type BallotsSource = { kind: 'poll'; pollId: string } | { kind: 'token'; token: string }

/**
 * Every ballot in the poll, so the tally can be checked rather than trusted.
 *
 * Only rendered when the poll was created with show_ballots — the caller
 * knows that from the poll it already has, so a failure here is a real
 * failure and gets shown, not swallowed.
 *
 * Row order is decided in the database and deliberately carries no
 * information when the ballots are unnamed; nothing here re-sorts it.
 */
export function Ballots({ source }: { source: BallotsSource }) {
  // Flattened to primitives so the dependency list is complete without
  // depending on a fresh object identity every render.
  const kind = source.kind
  const key = source.kind === 'poll' ? source.pollId : source.token
  const rpc = kind === 'poll' ? 'poll_ballots' : 'open_poll_ballots'

  // Ballots unlock on the same terms as the results and are as final: the
  // grid is cached for the life of the tab, like the tally. See
  // lib/settled.ts.
  const [sheet, setSheet] = useState<BallotSheet | null>(
    () => recall<BallotSheet>(rpc, key) ?? null,
  )
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const cached = recall<BallotSheet>(rpc, key)
    if (cached) {
      setSheet(cached)
      return
    }

    let cancelled = false

    const request =
      kind === 'poll'
        ? supabase.rpc('poll_ballots', { p_poll_id: key })
        : supabase.rpc('open_poll_ballots', { p_token: key })

    request.then(({ data, error: rpcError }) => {
      if (!rpcError) remember(rpc, key, data)
      if (cancelled) return
      if (rpcError) setError(rpcError.message)
      else setSheet(data as BallotSheet)
    })

    return () => {
      cancelled = true
    }
  }, [kind, key, rpc])

  if (error) {
    return (
      <Text c="red" size="sm">
        {error}
      </Text>
    )
  }

  if (!sheet) return <BallotsSkeleton />

  const named = sheet.voters_named
  // Unscored options count as 0 everywhere else in the app; a ballot missing
  // a score would have to predate the "score every option" rule, but reading
  // it as 0 keeps the columns adding up to what the tally says.
  const scoreOn = (scores: Record<string, number>, optionId: string) => scores[optionId] ?? 0
  const totals = sheet.options.map((o) =>
    sheet.ballots.reduce((sum, b) => sum + scoreOn(b.scores, o.id), 0),
  )

  return (
    <Card withBorder>
      <Stack gap="sm">
        <Group justify="space-between" gap="xs">
          <Title order={4}>Every ballot</Title>
          <Text size="sm" c="dimmed">
            {sheet.ballots.length} {sheet.ballots.length === 1 ? 'ballot' : 'ballots'}
          </Text>
        </Group>

        <Text size="sm" c="dimmed">
          {named
            ? 'This poll publishes its ballots with names, so the result can be checked line by line.'
            : 'This poll publishes its ballots without names, in an order unrelated to when they were cast. The columns add up to the score round, so the result can be checked without anyone being identified.'}
        </Text>

        <Table.ScrollContainer minWidth={120 + sheet.options.length * 90}>
          <Table striped withTableBorder>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{named ? 'Voter' : 'Ballot'}</Table.Th>
                {sheet.options.map((o) => (
                  <Table.Th key={o.id} ta="right">
                    {o.name}
                  </Table.Th>
                ))}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {/* Index as key: the list is static once fetched, and an
                  unnamed sheet has nothing else to key on by design. */}
              {sheet.ballots.map((ballot, i) => (
                <Table.Tr key={i}>
                  <Table.Td>
                    {named ? (
                      ballot.voter
                    ) : (
                      <Text size="sm" c="dimmed">
                        #{i + 1}
                      </Text>
                    )}
                  </Table.Td>
                  {sheet.options.map((o) => (
                    <Table.Td key={o.id} ta="right">
                      {scoreOn(ballot.scores, o.id)}
                    </Table.Td>
                  ))}
                </Table.Tr>
              ))}
            </Table.Tbody>
            <Table.Tfoot>
              <Table.Tr>
                <Table.Th>Total</Table.Th>
                {totals.map((total, i) => (
                  <Table.Th key={sheet.options[i].id} ta="right">
                    {total}
                  </Table.Th>
                ))}
              </Table.Tr>
            </Table.Tfoot>
          </Table>
        </Table.ScrollContainer>
      </Stack>
    </Card>
  )
}
