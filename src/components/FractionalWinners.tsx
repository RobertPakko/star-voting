import { useEffect, useState } from 'react'
import { ActionIcon, Anchor, Box, Group, Modal, Stack, Text, Tooltip } from '@mantine/core'
import { PieChart } from '@mantine/charts'
import { useReducedMotion } from '@mantine/hooks'
import { XIcon } from '@phosphor-icons/react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { isSampleId, openPollRpc, type RpcAnswer } from '../lib/samplePoll'
import { relabelScores } from '../lib/schedule'
import { fractionalSharesSchema, parseAnswer } from '../lib/rpcSchemas'
import { use24HourTime } from '../lib/clock'
import { percentagesOf } from '../lib/shares'
import { count } from '../lib/plural'
import { SCORING_ROWS_MAX } from '../lib/resultsRows'
import type { FractionalShare, PollResults } from '../lib/types'
import type { RankingSource } from './FullRanking'
import { RemovedOptions, type LeftOut } from './RemovedOptions'
import { SharesSkeleton } from './Skeletons'

/**
 * A slice colour per share, largest first. Ten, one for each option the
 * database shares between (`poll_results_rows()`), ordered so that slices
 * side by side differ in hue as well as shade. The legend names every slice
 * and its percentage, so colour is never the only way to tell them apart.
 */
const SLICE_COLORS = [
  'blue.6',
  'orange.6',
  'teal.6',
  'grape.6',
  'yellow.6',
  'cyan.7',
  'pink.6',
  'lime.7',
  'indigo.4',
  'red.7',
] as const

const cssColor = (color: string) => `var(--mantine-color-${color.replace('.', '-')})`

const PIE_SIZE = 200

/**
 * A share for every option rather than a place, opened from the result's
 * *More results* menu (`MoreResults`): the shares that make the product of
 * every voter's average stars largest (the Nash welfare). For a choice that
 * can be split — a budget, a run of meetings, an afternoon — where *Multiple
 * winners* is for picking several whole options. `/extensions` explains it,
 * and `poll_fractional_winners` works it out.
 *
 * **Only the ten options with the most stars are shared between**, so the
 * database's work is bounded by the voters rather than a time poll's hundreds
 * of windows. The modal says so when there are more, and removing one lets
 * the next in.
 *
 * **An option can be taken out**, as many as the reader likes, one after
 * another, exactly as in `MultipleWinners`: each removal asks the database to
 * share again as though that option had never been on the ballot. Removals
 * are the reader's alone, never stored, and kept while this poll's results
 * stay on screen.
 *
 * The pie is decorative and inert; the list under it is the answer, in words
 * and whole percentages that add up to 100 (`percentagesOf`).
 *
 * **The sample cannot remove**: it answers from a recording
 * (`samplePollData.ts`), which holds the shares with nothing taken out.
 */
export function FractionalWinners({
  source,
  results,
  opened,
  onClose,
}: {
  source: RankingSource
  /** Already relabelled by Results on a time poll; see relabelResults. */
  results: PollResults
  opened: boolean
  onClose: () => void
}) {
  const h24 = use24HourTime()
  const kind = source.kind
  const key = source.pollId
  const sample = isSampleId(key)

  const [leftOut, setLeftOut] = useState<LeftOut[]>([])
  const [shares, setShares] = useState<FractionalShare[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  // Another poll's removals mean nothing here.
  const [leftOutFor, setLeftOutFor] = useState(key)
  if (leftOutFor !== key) {
    setLeftOutFor(key)
    setLeftOut([])
    setShares(null)
  }

  // Sorted, so the same set asked for twice is the same request.
  const excludedKey = leftOut
    .map((o) => o.id)
    .sort()
    .join(',')

  useEffect(() => {
    if (!opened) return

    setError(null)
    setLoading(true)
    let cancelled = false

    const excluded = excludedKey ? excludedKey.split(',') : []
    const args = { p_poll_id: key, p_excluded: excluded }
    const request: PromiseLike<RpcAnswer> =
      kind === 'poll'
        ? supabase.rpc('get_poll_fractional_winners', args)
        : openPollRpc('open_poll_fractional_winners', args)

    request.then(({ data, error: rpcError }) => {
      if (cancelled) return
      setLoading(false)
      if (rpcError) return setError(rpcError.message)
      const { value, error: shape } = parseAnswer(fractionalSharesSchema, 'the shares', data)
      if (value) setShares(value)
      else setError(shape)
    })

    return () => {
      cancelled = true
    }
  }, [opened, kind, key, excludedKey])

  const remaining = results.option_count - leftOut.length
  // Below two there is nothing left to split.
  const canRemove = !sample && remaining > 2

  const remove = (option: LeftOut) => setLeftOut((list) => [...list, option])
  const restore = (id: string) => setLeftOut((list) => list.filter((o) => o.id !== id))

  const shown = shares && relabelScores(shares, h24)
  const unshared = shown ? remaining - shown.length : 0

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      size="lg"
      centered
      title={<Text fw={600}>Fractional winners</Text>}
    >
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          For splitting something between the options, like a budget or a run of meetings. Every
          option gets a share, sized so that each group of voters gets some of what it likes.{' '}
          <Anchor component={Link} to="/extensions?section=fractional-winners" inherit>
            How it works
          </Anchor>
        </Text>

        {!sample && (
          <Text size="sm" c="dimmed">
            If an option is not available, remove it and the shares are worked out again without it.
          </Text>
        )}

        <RemovedOptions leftOut={leftOut} onRestore={restore} onRestoreAll={() => setLeftOut([])} />

        {error && (
          <Text role="alert" c="red" size="sm">
            {error}
          </Text>
        )}

        {!error && !shown && (
          <SharesSkeleton size={PIE_SIZE} rows={Math.min(results.option_count, SCORING_ROWS_MAX)} />
        )}

        {shown && (
          <Stack
            gap="md"
            aria-busy={loading}
            style={{
              opacity: loading ? 0.5 : 1,
              transition: 'opacity var(--motion-fast)',
            }}
          >
            <Shares shares={shown} removable={canRemove && !loading} onRemove={remove} />
          </Stack>
        )}

        {shown && !loading && unshared > 0 && (
          <Text size="sm" c="dimmed">
            Shared between the {shown.length} options with the most stars;{' '}
            {count(unshared, 'more option')} {unshared === 1 ? 'was' : 'were'} not considered.
            Remove one to let the next in.
          </Text>
        )}
      </Stack>
    </Modal>
  )
}

/** The pie, and the list that says what it shows. */
function Shares({
  shares,
  removable,
  onRemove,
}: {
  shares: FractionalShare[]
  removable: boolean
  onRemove: (option: LeftOut) => void
}) {
  const reducedMotion = useReducedMotion(false, { getInitialValueInEffect: false })

  if (shares.every((s) => s.share === 0)) {
    return (
      <Text size="sm">
        Nobody gave any of these options a star, so there is nothing to share between them.
      </Text>
    )
  }

  const percent = percentagesOf(Object.fromEntries(shares.map((s) => [s.id, s.share])))
  // Largest first, as the database sends them, so colours run in order of size.
  const colorOf = new Map(shares.map((s, i) => [s.id, SLICE_COLORS[i % SLICE_COLORS.length]]))
  const data = shares
    .filter((s) => s.share > 0)
    .map((s) => ({ name: s.name, value: s.share, color: colorOf.get(s.id)! }))

  return (
    <>
      {/* Inert too: the chart draws a focusable surface. */}
      <Box aria-hidden inert style={{ display: 'flex', justifyContent: 'center' }}>
        <PieChart
          data={data}
          size={PIE_SIZE}
          startAngle={90}
          endAngle={-270}
          strokeWidth={1}
          accessibilityLayer={false}
          pieProps={{
            isAnimationActive: !reducedMotion,
            animationDuration: 500,
            animationEasing: 'ease-out',
          }}
        />
      </Box>

      <Stack component="ul" gap={4} m={0} p={0} style={{ listStyle: 'none' }}>
        {shares.map((s) => {
          const shared = s.share > 0
          const whole = percent[s.id]
          return (
            <Group component="li" key={s.id} gap="sm" wrap="nowrap" align="center">
              <Box
                w={10}
                h={10}
                style={{
                  borderRadius: 2,
                  flexShrink: 0,
                  backgroundColor: shared ? cssColor(colorOf.get(s.id)!) : 'transparent',
                  border: shared ? undefined : '1px solid var(--mantine-color-dimmed)',
                }}
              />
              <Text
                fw={shared ? 600 : undefined}
                c={shared ? undefined : 'dimmed'}
                style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}
              >
                {s.name}
              </Text>
              <Text
                size="sm"
                fw={shared ? 600 : undefined}
                c={shared ? undefined : 'dimmed'}
                style={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}
              >
                {!shared ? 'No share' : whole === 0 ? 'Under 1%' : `${whole}%`}
              </Text>
              {removable && (
                <Tooltip label="Remove and share again">
                  <ActionIcon
                    variant="subtle"
                    color="gray"
                    size="sm"
                    aria-label={`Remove ${s.name}`}
                    onClick={() => onRemove({ id: s.id, name: s.name })}
                  >
                    <XIcon size={14} aria-hidden />
                  </ActionIcon>
                </Tooltip>
              )}
            </Group>
          )
        })}
      </Stack>
    </>
  )
}
