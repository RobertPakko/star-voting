import { useEffect, useRef, useState } from 'react'
import { ActionIcon, Box, Button, Group, Stack, Text, Tooltip } from '@mantine/core'
import { PieChart } from '@mantine/charts'
import { useReducedMotion } from '@mantine/hooks'
import { SpinnerBallIcon, XIcon } from '@phosphor-icons/react'
import { supabase } from '../lib/supabase'
import { isSampleId, openPollRpc, type RpcAnswer } from '../lib/samplePoll'
import { relabelScores } from '../lib/schedule'
import { fractionalSharesSchema, parseAnswer } from '../lib/rpcSchemas'
import { use24HourTime } from '../lib/clock'
import { percentagesOf } from '../lib/shares'
import { landingFor, rotationTo } from '../lib/wheel'
import { motionMs } from '../lib/motion'
import { announce } from '../lib/announce'
import { count } from '../lib/plural'
import { SCORING_ROWS_MAX } from '../lib/resultsRows'
import type { FractionalShare, PollResults } from '../lib/types'
import type { RankingSource } from './FullRanking'
import { RemovedOptions, type LeftOut } from './RemovedOptions'
import { useLeftOut } from '../lib/useLeftOut'
import { SharesSkeleton } from './Skeletons'
import { ChoiceModal } from './ChoiceBlurb'

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
 * *More results* menu (`MoreResults`), or drawn on the results page where
 * the question chose it (`ChosenResult`): the shares that make the product of
 * every voter's average stars largest (the Nash welfare). For a choice that
 * can be split — a budget, a run of meetings, an afternoon — where *Multiple
 * winners* is for picking several whole options. `/choices` explains it,
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
 * and whole percentages that add up to 100 (`percentagesOf`). **Options with
 * no share are left off the list**: the percentages already account for the
 * whole, so a row of *No share* per option only buries the answer.
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
  // Held here rather than in the body, which is mounted only while open.
  const [leftOut, setLeftOut] = useLeftOut(source.pollId)

  return (
    <ChoiceModal kind="fractional" opened={opened} onClose={onClose}>
      <FractionalWinnersBody
        source={source}
        results={results}
        leftOut={leftOut}
        onLeftOut={setLeftOut}
      />
    </ChoiceModal>
  )
}

/**
 * The shares themselves, in the modal or on the results page. Handed the
 * shares the tally carried (`initial`), it asks for nothing until an option
 * is removed.
 */
export function FractionalWinnersBody({
  source,
  results,
  initial = null,
  leftOut,
  onLeftOut,
}: {
  source: RankingSource
  results: PollResults
  initial?: FractionalShare[] | null
  leftOut: LeftOut[]
  onLeftOut: (next: LeftOut[]) => void
}) {
  const h24 = use24HourTime()
  const kind = source.kind
  const key = source.pollId
  const sample = isSampleId(key)

  const [shares, setShares] = useState<FractionalShare[] | null>(
    leftOut.length === 0 ? initial : null,
  )
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  // Sorted, so the same set asked for twice is the same request.
  const excludedKey = leftOut
    .map((o) => o.id)
    .sort()
    .join(',')

  useEffect(() => {
    setError(null)
    // Nothing removed: the shares the tally carried are the answer.
    if (!excludedKey && initial) {
      setShares(initial)
      setLoading(false)
      return
    }

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
  }, [kind, key, excludedKey, initial])

  const remaining = results.option_count - leftOut.length
  // Below two there is nothing left to split.
  const canRemove = !sample && remaining > 2

  const remove = (option: LeftOut) => onLeftOut([...leftOut, option])
  const restore = (id: string) => onLeftOut(leftOut.filter((o) => o.id !== id))

  const shown = shares && relabelScores(shares, h24)
  const unshared = shown ? remaining - shown.length : 0

  return (
    <Stack gap="md">
      {!sample && (
        <Text size="sm" c="dimmed">
          If an option is not available, remove it and the shares are worked out again without it.
        </Text>
      )}

      <RemovedOptions leftOut={leftOut} onRestore={restore} onRestoreAll={() => onLeftOut([])} />

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
          {count(unshared, 'more option')} {unshared === 1 ? 'was' : 'were'} not considered. Remove
          one to let the next in.
        </Text>
      )}
    </Stack>
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

  const shared = shares.filter((s) => s.share > 0)
  const percent = percentagesOf(Object.fromEntries(shared.map((s) => [s.id, s.share])))
  // Largest first, as the database sends them, so colours run in order of size.
  const colorOf = new Map(shared.map((s, i) => [s.id, SLICE_COLORS[i % SLICE_COLORS.length]]))
  const data = shared.map((s) => ({ name: s.name, value: s.share, color: colorOf.get(s.id)! }))

  return (
    <>
      <Wheel
        // A new set of shares is a new wheel: an answer on screen was drawn from the old one.
        key={shared.map((s) => `${s.id}:${s.share}`).join(',')}
        shared={shared}
        data={data}
        reducedMotion={reducedMotion}
      />

      <Stack component="ul" gap={4} m={0} p={0} style={{ listStyle: 'none' }}>
        {shared.map((s) => {
          const whole = percent[s.id]
          return (
            <Group component="li" key={s.id} gap="sm" wrap="nowrap" align="center">
              <Box
                w={10}
                h={10}
                style={{
                  borderRadius: 2,
                  flexShrink: 0,
                  backgroundColor: cssColor(colorOf.get(s.id)!),
                }}
              />
              <Text fw={600} style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
                {s.name}
              </Text>
              <Text
                size="sm"
                fw={600}
                style={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}
              >
                {whole === 0 ? 'Under 1%' : `${whole}%`}
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

/** Whole turns a spin makes before it settles, so it reads as a spin. */
const TURNS = 5

/**
 * A wheel slowing under friction: fast off the mark, a long slow finish. The
 * one place the app leaves `--motion-ease`, which settles too early for a
 * wheel and gives away where it will stop.
 */
const WHEEL_EASE = 'cubic-bezier(0.1, 0.6, 0.15, 1)'

/**
 * The pie, which is also a wheel: *Spin the wheel* draws one option with
 * probability equal to its share (`landingFor`) and turns the pie until that
 * option is under the pointer. For a split made one decision at a time — a
 * run of movie nights, whose turn it is to pick — so that over many spins
 * each option comes up about as often as its share says.
 *
 * **The draw comes first and the spin only shows it.** Where the wheel stops
 * is decided before it moves, so nothing about the animation's timing can
 * change the answer. It is the second animation in the app allowed to be
 * enjoyed, after the coin, and for the same reason: a name simply stated
 * reads as a verdict, and the point is to be seen to be drawn. Under reduced
 * motion the wheel jumps to where it stops.
 *
 * Every spin is a fresh draw, made in this browser and written nowhere; see
 * `wheel.ts` for why this, unlike the coin, is not the same for every reader.
 * The sentence under the button states the answer, and it is announced.
 */
function Wheel({
  shared,
  data,
  reducedMotion,
}: {
  shared: FractionalShare[]
  data: { name: string; value: number; color: string }[]
  reducedMotion: boolean
}) {
  const wheel = useRef<HTMLDivElement>(null)
  const turned = useRef(0)
  const running = useRef<Animation | null>(null)
  const [spinning, setSpinning] = useState(false)
  const [landed, setLanded] = useState<string | null>(null)

  useEffect(() => () => running.current?.cancel(), [])

  const spin = () => {
    const element = wheel.current
    const landing = landingFor(shared)
    if (!element || !landing) return
    const name = shared.find((s) => s.id === landing.id)!.name

    const animate = !reducedMotion && typeof element.animate === 'function'
    const from = turned.current
    const to = rotationTo(from, landing.angle, animate ? TURNS : 0)
    // Kept within one turn, so the numbers never grow however often it is spun.
    turned.current = to % 360
    element.style.transform = `rotate(${turned.current}deg)`

    const done = () => {
      setSpinning(false)
      setLanded(name)
      announce(`The wheel landed on ${name}.`)
    }
    if (!animate) return done()

    setLanded(null)
    setSpinning(true)
    running.current = element.animate(
      [{ transform: `rotate(${from}deg)` }, { transform: `rotate(${to}deg)` }],
      { duration: motionMs('slow') * 8, easing: WHEEL_EASE },
    )
    // A cancelled spin (the wheel unmounting) rejects; there is nobody to tell.
    running.current.finished.then(done, () => {})
  }

  return (
    <Stack gap="sm" align="center">
      {/* Inert too: the chart draws a focusable surface. */}
      <Box aria-hidden inert pos="relative" pt={6}>
        <div ref={wheel}>
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
        </div>
        {/* The pointer, which stays still while the wheel turns under it. */}
        <Box
          pos="absolute"
          top={0}
          left="50%"
          style={{
            transform: 'translateX(-50%)',
            width: 0,
            height: 0,
            borderLeft: '9px solid transparent',
            borderRight: '9px solid transparent',
            borderTop: '18px solid var(--mantine-color-text)',
          }}
        />
      </Box>

      <Button
        variant="default"
        size="compact-sm"
        leftSection={<SpinnerBallIcon size={14} aria-hidden />}
        onClick={spin}
        disabled={spinning}
      >
        {landed ? 'Spin again' : 'Spin the wheel'}
      </Button>

      <Text size="sm" ta="center">
        {landed ? (
          <>
            The wheel landed on <b>{landed}</b>.
          </>
        ) : spinning ? (
          'Spinning…'
        ) : (
          'Spin the wheel to pick an option randomly.'
        )}
      </Text>
    </Stack>
  )
}
