import { useEffect, useState } from 'react'
import { Button, Group, NumberInput, Stack, Text } from '@mantine/core'
import { CalculatorIcon, PencilSimpleIcon } from '@phosphor-icons/react'
import { supabase } from '../lib/supabase'
import { isSampleId, openPollRpc, type RpcAnswer } from '../lib/samplePoll'
import { budgetSchema, parseAnswer } from '../lib/rpcSchemas'
import { amountError } from '../lib/pollForm'
import { AMOUNT_MAX } from '../lib/limits'
import { count } from '../lib/plural'
import { SCORING_ROWS_MAX } from '../lib/resultsRows'
import type { BudgetResult, PollResults } from '../lib/types'
import { ChoiceModal } from './ChoiceBlurb'
import { RankingSkeleton } from './Skeletons'
import type { RankingSource } from './FullRanking'
import { Spot } from './MultipleWinners'
import { RemovedOptions, type LeftOut } from './RemovedOptions'
import { useEveryOption } from '../lib/useEveryOption'
import { useBudgetInputs, useLeftOut, type BudgetInputs } from '../lib/useLeftOut'

/** An amount as the page writes it: whole, with thousands marked, and no unit. */
const amount = (n: number) => n.toLocaleString('en-US')

/**
 * *Proportional budget*, opened from the result's *More results* menu
 * (`MoreResults`), or drawn on the results page where the question chose it
 * (`ChosenResult`): cost-adjusted STAR once per option funded, among the
 * options that still fit, each ballot weakened by the stars it gave what was
 * funded, scaled by cost. `/choices` explains it, and
 * `poll_proportional_budget` counts it.
 *
 * **Costs can be given after the fact.** A budget question has its own; on
 * any other written list the reader types a cost per option and a budget,
 * and the count runs on those. Either way the reader can change them and
 * count again. Like removals, they are the reader's alone, never stored, and
 * kept while this poll's results stay on screen. Voters never saw a cost, so
 * nothing about the ballots depends on when one was given.
 *
 * **The sample cannot recount**: it answers from a recording, which holds
 * the count with the question's own costs and nothing removed.
 */
export function ProportionalBudget({
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
    <ChoiceModal kind="budget" calendar={results.calendar} opened={opened} onClose={onClose}>
      <ProportionalBudgetBody
        source={source}
        results={results}
        leftOut={leftOut}
        onLeftOut={setLeftOut}
        inputs={inputs}
        onInputs={setInputs}
      />
    </ChoiceModal>
  )
}

/**
 * The count itself, in the modal or on the results page. Handed the count the
 * tally carried (`initial`), it asks for nothing until an option is removed
 * or a cost changed.
 */
export function ProportionalBudgetBody({
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
  initial?: BudgetResult | null
  leftOut: LeftOut[]
  onLeftOut: (next: LeftOut[]) => void
  inputs: BudgetInputs | null
  onInputs: (next: BudgetInputs | null) => void
}) {
  const kind = source.kind
  const key = source.pollId
  const sample = isSampleId(key)
  // A budget question costs its own options; any other asks the reader first.
  const ownCosts = results.kind === 'budget'
  const needsCosts = !ownCosts && !inputs

  const [result, setResult] = useState<BudgetResult | null>(
    leftOut.length === 0 && !inputs ? initial : null,
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
    if (!excludedKey && !inputsKey && initial) {
      setResult(initial)
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
    }
    const request: PromiseLike<RpcAnswer> =
      kind === 'poll'
        ? supabase.rpc('get_poll_proportional_budget', args)
        : openPollRpc('open_poll_proportional_budget', args)

    request.then(({ data, error: rpcError }) => {
      if (cancelled) return
      setLoading(false)
      if (rpcError) return setError(rpcError.message)
      const { value, error: shape } = parseAnswer(budgetSchema, 'the budget', data)
      if (value) setResult(value)
      else setError(shape)
    })

    return () => {
      cancelled = true
    }
  }, [kind, key, excludedKey, inputsKey, initial, needsCosts])

  const remaining = results.option_count - leftOut.length
  const canRemove = !sample && remaining > 1

  const remove = (option: LeftOut) => onLeftOut([...leftOut, option])
  const restore = (id: string) => onLeftOut(leftOut.filter((o) => o.id !== id))

  // Every cost the count was given, for the cost beside each option and for
  // the editor to start from.
  const costById = new Map<string, number>()
  for (const spot of result?.spots ?? []) for (const o of spot.options) costById.set(o.id, o.cost)
  for (const o of result?.unfunded ?? []) costById.set(o.id, o.cost)
  for (const o of result?.tied ?? []) costById.set(o.id, o.cost)

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
              budget: result?.budget ?? 0,
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
          <Text fw={600}>
            {amount(result.spent)} of {amount(result.budget)} spent, {amount(result.left)} left
            over.
          </Text>

          {result.spots.length === 0 && !result.tied && (
            <Text size="sm">Nothing fits in the budget.</Text>
          )}

          {result.spots.map((spot) => (
            <Spot
              key={spot.place}
              spot={spot}
              removable={canRemove && !loading}
              onRemove={remove}
              aside={(id) => (
                <Text size="sm" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                  · costs {amount(costById.get(id) ?? 0)}
                </Text>
              )}
            />
          ))}

          {result.tied && (
            <Text size="sm" c="orange">
              {result.tied.map((o) => o.name).join(' and ')} tied on every rule, and only one fits
              in the {amount(result.spots.at(-1)?.left ?? result.budget)} left, so neither is funded
              and the count stops there.
            </Text>
          )}

          {result.unfunded.length > 0 && (
            <Stack gap={2}>
              <Text size="sm" fw={600}>
                Not funded
              </Text>
              <Text size="sm" c="dimmed">
                {result.unfunded.map((o) => `${o.name} (${amount(o.cost)})`).join(', ')}
              </Text>
            </Stack>
          )}

          {result.uncosted.length > 0 && (
            <Text size="sm" c="dimmed">
              {count(result.uncosted.length, 'option')} with no cost{' '}
              {result.uncosted.length === 1 ? 'was' : 'were'} not counted.
            </Text>
          )}
        </Stack>
      )}
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
