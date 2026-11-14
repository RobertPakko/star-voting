import { useEffect, useState } from 'react'
import {
  ActionIcon,
  Button,
  Group,
  NumberInput,
  Progress,
  SegmentedControl,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core'
import { CalculatorIcon, PencilSimpleIcon, XIcon } from '@phosphor-icons/react'
import { supabase } from '../lib/supabase'
import { isSampleId, openPollRpc, type RpcAnswer } from '../lib/samplePoll'
import { budgetSchema, fractionalBudgetSchema, parseAnswer } from '../lib/rpcSchemas'
import { amountError } from '../lib/pollForm'
import { AMOUNT_MAX } from '../lib/limits'
import { count } from '../lib/plural'
import { SCORING_ROWS_MAX } from '../lib/resultsRows'
import type { BudgetResult, FractionalBudgetResult, PollResults } from '../lib/types'
import { VariantModal } from './ChoiceBlurb'
import {
  BUDGET_COUNTS,
  CHOICES,
  budgetCountOf,
  isBudgetKind,
  type BudgetCount,
} from '../lib/choices'
import { RankingSkeleton } from './Skeletons'
import type { RankingSource } from './FullRanking'
import { Spot } from './MultipleWinners'
import { RemovedOptions, type LeftOut } from './RemovedOptions'
import { useEveryOption } from '../lib/useEveryOption'
import { useBudgetInputs, useLeftOut, type BudgetInputs } from '../lib/useLeftOut'

/**
 * An amount as the page writes it, with thousands marked and no unit: whole
 * where it is (every cost and budget), else to two places (a part funded).
 */
const amount = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 })

/** What each count is called in the switch, and the line under it. */
const COUNT_LINES: Record<BudgetCount, string> = {
  ranking: 'Funds the most popular options, skipping any that no longer fit.',
  multiple: 'Funds options so that different groups of voters each get something they like.',
  fractional:
    'Funds options in part, up to what each costs, so that the budget is split as fairly as it can be.',
}

/** Either count's answer, with the count that gave it. */
type Counted =
  | { count: 'ranking' | 'multiple'; value: BudgetResult }
  | { count: 'fractional'; value: FractionalBudgetResult }

/** A count the tally carried, as `Counted`. */
const countedOf = (
  count: BudgetCount,
  value: BudgetResult | FractionalBudgetResult | null,
): Counted | null =>
  !value
    ? null
    : count === 'fractional'
      ? 'outside' in value
        ? { count, value }
        : null
      : 'spots' in value
        ? { count, value }
        : null

/**
 * The *Budget variant*, opened from the result's *More results* menu
 * (`MoreResults`), or drawn on the results page where the question is a
 * budget poll (`ChosenResult`): options funded out of a budget, by one of
 * three counts. *Proportional winners* is cost-adjusted STAR once per option
 * funded, among the options that still fit, each ballot weakened by the stars
 * it gave what was funded, scaled by cost; *Multiple winners* is plain STAR
 * again and again over what still fits, charging nobody; *Fractional winners*
 * funds every option in part, up to its cost, to make the product of what
 * every voter is served as large as it can be. `/variants` explains them,
 * and `poll_budget_count` counts them.
 *
 * **Costs can be given after the fact.** A budget question has its own; on
 * any other written list the reader types a cost per option and a budget,
 * and chooses which count to run, and the count runs on those. Either way the reader can change them and
 * count again. Like removals, they are the reader's alone, never stored, and
 * kept while this poll's results stay on screen. Voters never saw a cost, so
 * nothing about the ballots depends on when one was given.
 *
 * **The sample cannot recount**: it answers from a recording, which holds
 * the count with the question's own costs and nothing removed.
 */
export function BudgetVariant({
  source,
  results,
  opened,
  onClose,
}: {
  source: RankingSource
  results: PollResults
  opened: boolean
  onClose: () => void
}) {
  // Held here rather than in the body, which is mounted only while open.
  const [leftOut, setLeftOut] = useLeftOut(source.pollId)
  const [inputs, setInputs] = useBudgetInputs(source.pollId)

  return (
    <VariantModal variant="budget" opened={opened} onClose={onClose}>
      <BudgetBody
        source={source}
        results={results}
        leftOut={leftOut}
        onLeftOut={setLeftOut}
        inputs={inputs}
        onInputs={setInputs}
      />
    </VariantModal>
  )
}

/**
 * The count itself, in the modal or on the results page. Handed the count the
 * tally carried (`initial`), it asks for nothing until an option is removed
 * or a cost changed.
 */
export function BudgetBody({
  source,
  results,
  initial = null,
  leftOut,
  onLeftOut,
  inputs,
  onInputs,
}: {
  source: RankingSource
  results: PollResults
  initial?: BudgetResult | FractionalBudgetResult | null
  leftOut: LeftOut[]
  onLeftOut: (next: LeftOut[]) => void
  inputs: BudgetInputs | null
  onInputs: (next: BudgetInputs | null) => void
}) {
  const kind = source.kind
  const key = source.pollId
  const sample = isSampleId(key)
  // A budget question costs its own options; any other asks the reader first.
  const ownCosts = isBudgetKind(results.kind)
  const needsCosts = !ownCosts && !inputs
  // Which count runs: the reader's, or the question's own.
  const ownCount = budgetCountOf(results.kind)
  const budgetCount = inputs?.count ?? ownCount

  const [result, setResult] = useState<Counted | null>(
    leftOut.length === 0 && !inputs ? countedOf(ownCount, initial) : null,
  )
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [editing, setEditing] = useState(needsCosts)

  // Sorted, so the same set asked for twice is the same request.
  const excludedKey = leftOut
    .map((o) => o.id)
    .sort()
    .join(',')
  const inputsKey = inputs ? JSON.stringify(inputs) : ''

  useEffect(() => {
    setError(null)
    // Nothing to count with yet: the editor asks for costs first.
    if (needsCosts) {
      setResult(null)
      setLoading(false)
      return
    }
    // The question's own costs with nothing removed: the tally carried it.
    const own = countedOf(ownCount, initial)
    if (!excludedKey && !inputsKey && own) {
      setResult(own)
      setLoading(false)
      return
    }

    setLoading(true)
    let cancelled = false

    const typed: BudgetInputs | null = inputsKey ? JSON.parse(inputsKey) : null
    const args = {
      p_poll_id: key,
      p_excluded: excludedKey ? excludedKey.split(',') : [],
      p_costs: typed?.costs,
      p_budget: typed?.budget,
      p_choice: budgetCount,
    }
    const request: PromiseLike<RpcAnswer> =
      kind === 'poll'
        ? supabase.rpc('get_poll_budget', args)
        : openPollRpc('open_poll_budget', args)

    request.then(({ data, error: rpcError }) => {
      if (cancelled) return
      setLoading(false)
      if (rpcError) return setError(rpcError.message)
      if (budgetCount === 'fractional') {
        const { value, error: shape } = parseAnswer(fractionalBudgetSchema, 'the budget', data)
        if (value) setResult({ count: budgetCount, value })
        else setError(shape)
      } else {
        const { value, error: shape } = parseAnswer(budgetSchema, 'the budget', data)
        if (value) setResult({ count: budgetCount, value })
        else setError(shape)
      }
    })

    return () => {
      cancelled = true
    }
  }, [kind, key, excludedKey, inputsKey, initial, ownCount, needsCosts, budgetCount])

  const remaining = results.option_count - leftOut.length
  const canRemove = !sample && remaining > 1

  const remove = (option: LeftOut) => onLeftOut([...leftOut, option])
  const restore = (id: string) => onLeftOut(leftOut.filter((o) => o.id !== id))

  // Every cost the count was given, for the cost beside each option and for
  // the editor to start from.
  const costById = new Map<string, number>()
  if (result?.count === 'fractional') {
    const { options, unfunded, outside } = result.value
    for (const o of [...options, ...unfunded, ...outside]) costById.set(o.id, o.cost)
  } else if (result) {
    const { spots, unfunded, tied } = result.value
    for (const spot of spots) for (const o of spot.options) costById.set(o.id, o.cost)
    for (const o of [...unfunded, ...(tied ?? [])]) costById.set(o.id, o.cost)
  }

  return (
    <Stack gap="md">
      {!sample && !editing && (
        <Group justify="space-between" align="flex-start" wrap="nowrap" gap="sm">
          <Text size="sm" c="dimmed">
            If an option is not available, remove it and the budget is shared out again without it.
          </Text>
          <Button
            variant="default"
            size="compact-sm"
            leftSection={<PencilSimpleIcon size={14} aria-hidden />}
            onClick={() => setEditing(true)}
            style={{ flexShrink: 0 }}
          >
            Edit costs
          </Button>
        </Group>
      )}

      {editing && (
        <CostEditor
          source={source}
          results={results}
          leftOut={leftOut}
          start={
            inputs ?? {
              costs: Object.fromEntries(costById),
              budget: result?.value.budget ?? 0,
              count: budgetCount,
            }
          }
          ownCosts={ownCosts}
          canCancel={!needsCosts}
          onCount={(next) => {
            onInputs(next)
            setEditing(false)
          }}
          onCancel={() => setEditing(false)}
        />
      )}

      {!editing && (
        <RemovedOptions leftOut={leftOut} onRestore={restore} onRestoreAll={() => onLeftOut([])} />
      )}

      {error && (
        <Text role="alert" c="red" size="sm">
          {error}
        </Text>
      )}

      {!editing && !error && !result && (
        <RankingSkeleton places={Math.min(remaining, SCORING_ROWS_MAX)} />
      )}

      {!editing && result && (
        <Stack
          gap="md"
          aria-busy={loading}
          style={{ opacity: loading ? 0.5 : 1, transition: 'opacity var(--motion-fast)' }}
        >
          <Stack gap={2}>
            <Text fw={600}>
              {amount(result.value.spent)} of {amount(result.value.budget)} spent,{' '}
              {amount(result.value.left)} left over.
            </Text>
            <Text size="sm" c="dimmed">
              Counted as {CHOICES[result.count].label.toLowerCase()}.
            </Text>
          </Stack>

          {result.count === 'fractional' ? (
            <FundedList result={result.value} removable={canRemove && !loading} onRemove={remove} />
          ) : (
            <SpotList
              result={result.value}
              costById={costById}
              removable={canRemove && !loading}
              onRemove={remove}
            />
          )}

          {result.value.unfunded.length > 0 && (
            <Stack gap={2}>
              <Text size="sm" fw={600}>
                Not funded
              </Text>
              <Text size="sm" c="dimmed">
                {result.value.unfunded.map((o) => `${o.name} (${amount(o.cost)})`).join(', ')}
              </Text>
            </Stack>
          )}

          {result.count === 'fractional' && result.value.outside.length > 0 && (
            <Text size="sm" c="dimmed">
              {count(result.value.outside.length, 'more option')}{' '}
              {result.value.outside.length === 1 ? 'was' : 'were'} not considered: only the{' '}
              {SCORING_ROWS_MAX} with the most stars are funded. Remove one to let the next in.
            </Text>
          )}

          {result.value.uncosted.length > 0 && (
            <Text size="sm" c="dimmed">
              {count(result.value.uncosted.length, 'option')} with no cost{' '}
              {result.value.uncosted.length === 1 ? 'was' : 'were'} not counted.
            </Text>
          )}
        </Stack>
      )}
    </Stack>
  )
}

/** Multiple or proportional winners with a budget: a spot per round, each with its cost. */
function SpotList({
  result,
  costById,
  removable,
  onRemove,
}: {
  result: BudgetResult
  costById: Map<string, number>
  removable: boolean
  onRemove: (option: LeftOut) => void
}) {
  return (
    <>
      {result.spots.length === 0 && !result.tied && (
        <Text size="sm">Nothing fits in the budget.</Text>
      )}

      {result.spots.map((spot) => (
        <Spot
          key={spot.place}
          spot={spot}
          removable={removable}
          onRemove={onRemove}
          aside={(id) => (
            <Text size="sm" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
              · costs {amount(costById.get(id) ?? 0)}
            </Text>
          )}
        />
      ))}

      {result.tied && (
        <Text size="sm" c="orange">
          {result.tied.map((o) => o.name).join(' and ')} tied on every rule, and only one fits in
          the {amount(result.spots.at(-1)?.left ?? result.budget)} left, so neither is funded and
          the count stops there.
        </Text>
      )}
    </>
  )
}

/**
 * Fractional winners with a budget: every option given something, the most
 * first, with what it was given out of what it costs and a bar of how much of
 * it that funds. The bar repeats the figures beside it, so it carries nothing
 * alone.
 */
function FundedList({
  result,
  removable,
  onRemove,
}: {
  result: FractionalBudgetResult
  removable: boolean
  onRemove: (option: LeftOut) => void
}) {
  if (result.options.length === 0) {
    return (
      <Text size="sm">Nobody gave any of these options a star, so there is nothing to fund.</Text>
    )
  }

  return (
    <Stack component="ul" gap="sm" m={0} p={0} style={{ listStyle: 'none' }}>
      {result.options.map((o) => {
        const percent = Math.round(o.funded * 100)
        return (
          <Stack component="li" key={o.id} gap={4}>
            <Group gap="xs" wrap="nowrap" align="center">
              <Text fw={600} style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
                {o.name}
              </Text>
              <Text size="sm" style={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                {amount(o.amount)} of {amount(o.cost)}
              </Text>
              <Text
                size="sm"
                fw={600}
                w={72}
                ta="right"
                style={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}
              >
                {o.funded >= 1 ? 'In full' : percent === 0 ? 'Under 1%' : `${percent}%`}
              </Text>
              {removable && (
                <Tooltip label="Remove and count again">
                  <ActionIcon
                    variant="subtle"
                    color="gray"
                    size="sm"
                    aria-label={`Remove ${o.name}`}
                    onClick={() => onRemove({ id: o.id, name: o.name })}
                  >
                    <XIcon size={14} aria-hidden />
                  </ActionIcon>
                </Tooltip>
              )}
            </Group>
            <Progress value={o.funded * 100} size="sm" aria-hidden />
          </Stack>
        )
      })}
    </Stack>
  )
}

/**
 * The reader's costs and budget: every option on the ballot (less any
 * removed), a cost beside each, and *Count*. On a question that is not a
 * budget it is the first thing the modal shows. Nothing typed here is saved.
 */
function CostEditor({
  source,
  results,
  leftOut,
  start,
  ownCosts,
  canCancel,
  onCount,
  onCancel,
}: {
  source: RankingSource
  results: PollResults
  leftOut: LeftOut[]
  start: BudgetInputs
  ownCosts: boolean
  canCancel: boolean
  onCount: (next: BudgetInputs) => void
  onCancel: () => void
}) {
  const options = useEveryOption(source, results)
  const [budget, setBudget] = useState<number | string>(start.budget || '')
  const [budgetCount, setBudgetCount] = useState(start.count)
  const [costs, setCosts] = useState<Record<string, number | string>>(() =>
    Object.fromEntries(Object.entries(start.costs).map(([id, c]) => [id, c ?? ''])),
  )
  const [tried, setTried] = useState(false)

  const shown = options?.filter((o) => !leftOut.some((l) => l.id === o.id)) ?? null
  const budgetError = amountError(budget)
  const costErrors = new Map(
    (shown ?? []).flatMap((o) => {
      const cost = costs[o.id] ?? ''
      const problem = cost === '' ? null : amountError(cost)
      return problem ? [[o.id, problem] as const] : []
    }),
  )
  const anyCost = (shown ?? []).some((o) => (costs[o.id] ?? '') !== '')

  function submit() {
    setTried(true)
    if (!shown || budgetError || costErrors.size > 0 || !anyCost) return
    onCount({
      budget: Number(budget),
      count: budgetCount,
      costs: Object.fromEntries(
        shown.map((o) => [
          o.id,
          costs[o.id] === '' || costs[o.id] === undefined ? null : Number(costs[o.id]),
        ]),
      ),
    })
  }

  return (
    <Stack gap="sm">
      <Text size="sm" c="dimmed">
        {ownCosts
          ? 'Try other costs or another budget. Nothing you change here is saved.'
          : 'Give the options their costs and a budget to share out. Options left without a cost are not counted, and nothing you type here is saved.'}
      </Text>

      {/* Each label is its choice's first word, so three fit across a phone. */}
      <SegmentedControl
        fullWidth
        aria-label="Count as"
        value={budgetCount}
        onChange={(v) => setBudgetCount(v as BudgetCount)}
        data={BUDGET_COUNTS.map((c) => ({
          value: c,
          label: CHOICES[c].label.split(' ')[0],
        }))}
      />
      <Text size="xs" c="dimmed" mt={-6}>
        {CHOICES[budgetCount].label}: {COUNT_LINES[budgetCount].toLowerCase()}
      </Text>

      <NumberInput
        label="Budget"
        value={budget}
        onChange={setBudget}
        min={1}
        max={AMOUNT_MAX}
        allowDecimal={false}
        allowNegative={false}
        thousandSeparator=","
        error={tried && budgetError ? (budget === '' ? 'Give the budget.' : budgetError) : null}
      />

      {!shown && <RankingSkeleton places={Math.min(results.option_count, SCORING_ROWS_MAX)} />}

      {shown && (
        <Stack gap={6}>
          <Text size="sm" fw={500}>
            Costs
          </Text>
          {shown.map((option) => (
            <Group key={option.id} gap="sm" wrap="nowrap" align="flex-start">
              <Text size="sm" style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }} pt={6}>
                {option.name}
              </Text>
              <NumberInput
                w={120}
                size="sm"
                aria-label={`Cost of ${option.name}`}
                placeholder="No cost"
                value={costs[option.id] ?? ''}
                onChange={(v) => setCosts((prev) => ({ ...prev, [option.id]: v }))}
                min={1}
                max={AMOUNT_MAX}
                allowDecimal={false}
                allowNegative={false}
                thousandSeparator=","
                hideControls
                error={tried ? costErrors.get(option.id) : null}
              />
            </Group>
          ))}
        </Stack>
      )}

      {tried && shown && !anyCost && (
        <Text role="alert" c="red" size="sm">
          Give at least one option a cost.
        </Text>
      )}

      <Group justify="flex-end" gap="xs">
        {canCancel && (
          <Button variant="default" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button
          onClick={submit}
          disabled={!shown}
          leftSection={<CalculatorIcon size={16} aria-hidden />}
        >
          Count
        </Button>
      </Group>
    </Stack>
  )
}
