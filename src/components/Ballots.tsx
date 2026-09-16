import { useEffect, useRef, useState } from 'react'
import { ActionIcon, Group, Stack, Table, Text, Title, Tooltip } from '@mantine/core'
import { DownloadSimpleIcon } from '@phosphor-icons/react'
import { supabase } from '../lib/supabase'
import { openPollRpc, type RpcAnswer } from '../lib/samplePoll'
import { ballotsCsv, ballotsFileName, downloadCsv } from '../lib/ballotCsv'
import { Reveal } from './Reveal'
import { BallotsSkeleton } from './Skeletons'
import { relabelSheet } from '../lib/schedule'
import type { BallotSheet } from '../lib/types'

/**
 * Which ballot endpoint to read. Same split as ResultsSource, and for the
 * same reason: a session proves the caller's right to an invite poll, the
 * link proves it for an open one.
 */
export type BallotsSource = { kind: 'poll'; pollId: string } | { kind: 'open'; pollId: string }

/**
 * Every ballot in the poll, so the tally can be checked rather than trusted.
 *
 * Only rendered when the poll was created with show_ballots. The caller
 * knows that from the poll it already has, so a failure here is a real
 * failure and gets shown, not swallowed.
 *
 * Row order is decided in the database and deliberately carries no
 * information when the ballots are unnamed; nothing here re-sorts it.
 */
export function Ballots({
  source,
  title,
  question,
  initial = null,
}: {
  source: BallotsSource
  /**
   * What the poll is called, and what this question of it asks -- the two
   * halves of the downloaded file's name, and nothing else. Both optional:
   * a caller that has no title in hand gets `poll-ballots.csv`, which is a
   * duller filename and the same file.
   */
  title?: string
  question?: string | null
  /**
   * The sheet the read that opened this page already brought, or null when it
   * brought none. `poll_page` carries it on exactly the polls whose page
   * draws this grid — see 0051, which made the sheet wait for the same gate
   * the tally waits for, which is what let it travel with the page at all.
   *
   * Null is where this grid has always been: a poll that finished while
   * somebody was watching it, a crossing between two questions, and the
   * sample. It reads for itself, exactly as before.
   */
  initial?: BallotSheet | null
}) {
  // Flattened to primitives so the dependency list is complete without
  // depending on a fresh object identity every render.
  const kind = source.kind
  const key = source.pollId

  // Read every time the grid is drawn, like the tally above it and for the
  // same reason: a reset takes a poll's ballots away and tells nobody, so a
  // sheet held for the life of the tab is a sheet that can outlive the votes
  // on it. See the note in Results.
  const [sheet, setSheet] = useState<BallotSheet | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Taken once and then gone, for the reason this grid re-reads at all: a
  // reset takes a poll's ballots away and tells nobody, so a re-read must
  // never come back with the sheet from before it.
  const handoff = useRef(initial)

  useEffect(() => {
    const given = handoff.current
    handoff.current = null
    if (given) {
      setSheet(given)
      return
    }

    let cancelled = false
    const request: PromiseLike<RpcAnswer> =
      kind === 'poll'
        ? supabase.rpc('poll_ballots', { p_poll_id: key })
        : openPollRpc('open_poll_ballots', { p_poll_id: key })

    request.then(({ data, error: rpcError }) => {
      if (cancelled) return
      if (rpcError) setError(rpcError.message)
      else setSheet(data as BallotSheet)
    })

    return () => {
      cancelled = true
    }
  }, [kind, key])

  if (error) {
    return (
      <Text c="red" size="sm">
        {error}
      </Text>
    )
  }

  if (!sheet) return <BallotsSkeleton />

  // The columns of a time poll's sheet are its windows, which are stored as
  // ISO timestamps and read as headings; see relabelSheet. Applied to every
  // poll, because an ordinary poll's options are not window starts and come
  // back exactly as they went in.
  const shown = relabelSheet(sheet)
  const named = shown.voters_named
  // Unscored options count as 0 everywhere else in the app; a ballot missing
  // a score would have to predate the "score every option" rule, but reading
  // it as 0 keeps the columns adding up to what the tally says.
  const scoreOn = (scores: Record<string, number>, optionId: string) => scores[optionId] ?? 0
  const totals = shown.options.map((o) =>
    shown.ballots.reduce((sum, b) => sum + scoreOn(b.scores, o.id), 0),
  )

  // Faded in over the shape that was standing in for it; see Reveal.
  return (
    <Reveal>
      <Stack gap={2}>
        {/* The download sits on the heading rather than under the grid,
            because the grid is as long as the poll had voters and a control
            below it is a control nobody scrolls to. An icon and no label:
            adding a poll up for yourself is a thing a handful of readers will
            ever want, and the ones who do go looking for exactly this. Absent
            on a sheet with no ballots on it, which is a file with nothing in
            it. See lib/ballotCsv.ts. */}
        <Group justify="space-between" wrap="nowrap" align="center" gap="xs">
          <Title order={4}>Ballots</Title>
          {shown.ballots.length > 0 && (
            <Tooltip label="Download these ballots as a CSV" withArrow>
              <ActionIcon
                variant="subtle"
                color="gray"
                aria-label="Download these ballots as a CSV"
                onClick={() =>
                  downloadCsv(ballotsCsv(shown), ballotsFileName(title ?? '', question))
                }
              >
                <DownloadSimpleIcon size={18} aria-hidden />
              </ActionIcon>
            </Tooltip>
          )}
        </Group>
        <Table.ScrollContainer minWidth={120 + shown.options.length * 90}>
          <Table striped withTableBorder withColumnBorders>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{named ? 'Voter' : 'Ballot'}</Table.Th>
                {shown.options.map((o) => (
                  <Table.Th key={o.id} ta="right">
                    {o.name}
                  </Table.Th>
                ))}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {/* Index as key: the list is static once fetched, and an
                  unnamed sheet has nothing else to key on by design. */}
              {shown.ballots.map((ballot, i) => (
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
                  {shown.options.map((o) => (
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
                  <Table.Th key={shown.options[i].id} ta="right">
                    {total}
                  </Table.Th>
                ))}
              </Table.Tr>
            </Table.Tfoot>
          </Table>
        </Table.ScrollContainer>
      </Stack>
    </Reveal>
  )
}
