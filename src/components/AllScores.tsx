import { useEffect, useState } from 'react'
import { Group, Modal, Progress, Stack, Text } from '@mantine/core'
import { supabase } from '../lib/supabase'
import { openPollRpc, type RpcAnswer } from '../lib/samplePoll'
import { optionScoresSchema, parseAnswer } from '../lib/rpcSchemas'
import { relabelScores } from '../lib/schedule'
import { use24HourTime } from '../lib/clock'
import { stars } from '../lib/plural'
import type { OptionScore } from '../lib/types'
import { ScoresSkeleton } from './Skeletons'
import classes from './Results.module.css'

/** Which scores endpoint to read; the same split as the tally's and the ranking's. */
type ScoresSource = { kind: 'poll'; pollId: string } | { kind: 'open'; pollId: string }

/**
 * Every option's score, opened from under a score round the database cut at
 * ten (`poll_results_rows()`).
 *
 * **Fetched when the button is pressed**, like the full ranking: the tally
 * carries only the top rows, so a poll of hundreds of windows does not send
 * them all to every reader of its result. This read is plain sums — no
 * tie-breaks, no runoff — so it is cheap whenever it is asked for. Not held
 * on to, for the same reason the ranking is not: the votes under it can move.
 *
 * The server orders by total, then name. The finalists are lifted above
 * anything they tied with, as the score round does, so the two lists agree
 * about their first rows.
 */
export function AllScores({
  source,
  optionCount,
  finalists,
  opened,
  onClose,
}: {
  source: ScoresSource
  /** For the skeleton and the title. */
  optionCount: number
  /** The tally's finalists, drawn bold and in blue as the score round draws them. */
  finalists: string[]
  opened: boolean
  onClose: () => void
}) {
  const h24 = use24HourTime()
  const kind = source.kind
  const key = source.pollId

  const [scores, setScores] = useState<OptionScore[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!opened) return

    // Cleared, so closing a failed modal and opening it again is a retry.
    setError(null)

    let cancelled = false

    const request: PromiseLike<RpcAnswer> =
      kind === 'poll'
        ? supabase.rpc('get_poll_scores', { p_poll_id: key })
        : openPollRpc('open_poll_scores', { p_poll_id: key })

    request.then(({ data, error: rpcError }) => {
      if (cancelled) return
      if (rpcError) return setError(rpcError.message)
      const { value, error: shape } = parseAnswer(optionScoresSchema, 'the scores', data)
      if (value) setScores(value)
      else setError(shape)
    })

    return () => {
      cancelled = true
    }
  }, [opened, kind, key])

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      size="lg"
      centered
      title={<Text fw={600}>All scores</Text>}
    >
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          Every option&apos;s total from the scoring round, highest first.
        </Text>

        {error && (
          <Text role="alert" c="red" size="sm">
            {error}
          </Text>
        )}

        {!error && !scores && <ScoresSkeleton rows={optionCount} />}

        {scores && (
          <ScoreList
            scores={relabelScores(liftFinalists(scores, finalists), h24)}
            finalists={finalists}
          />
        )}
      </Stack>
    </Modal>
  )
}

function ScoreList({ scores, finalists }: { scores: OptionScore[]; finalists: string[] }) {
  const maxScore = Math.max(1, ...scores.map((o) => o.total_score))

  return (
    <Stack gap="xs">
      {scores.map((o) => {
        const finalist = finalists.includes(o.id)
        return (
          <div key={o.id}>
            <Group justify="space-between" mb={2} wrap="nowrap" gap="xs">
              <Text
                size="sm"
                fw={finalist ? 700 : 400}
                style={{ minWidth: 0, overflowWrap: 'anywhere' }}
              >
                {o.name}
              </Text>
              <Text size="sm" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                {stars(o.total_score)} (avg {o.average_score})
              </Text>
            </Group>
            {/* The stars are already in words above. Drawn full at once: a
                list this long is read, not watched. */}
            <Progress
              aria-hidden
              value={(o.total_score / maxScore) * 100}
              color={finalist ? 'blue' : 'var(--muted-bar)'}
              classNames={{ root: classes.bar }}
            />
          </div>
        )
      })}
    </Stack>
  )
}

/**
 * The finalists moved above options on the same total, keeping everything
 * else in the server's order — the order `poll_tally` gives the score round.
 */
function liftFinalists(scores: OptionScore[], finalists: string[]): OptionScore[] {
  const rank = (o: OptionScore) => (finalists.includes(o.id) ? 0 : 1)
  return scores
    .map((o, i) => ({ o, i }))
    .sort((x, y) => y.o.total_score - x.o.total_score || rank(x.o) - rank(y.o) || x.i - y.i)
    .map(({ o }) => o)
}
