import { useEffect, useState } from 'react'
import { Button, Group, SegmentedControl, Select, Stack, Text } from '@mantine/core'
import { CaretDownIcon } from '@phosphor-icons/react'
import { supabase } from '../lib/supabase'
import { isSampleId, openPollRpc, type RpcAnswer } from '../lib/samplePoll'
import { groupsSchema, parseAnswer, pollResultsSchema } from '../lib/rpcSchemas'
import { CHOICE_NUMBERS, choiceNumberLabel, groupsFor } from '../lib/choices'
import { CountingGroup, groupCount, type CountSource, type GroupRef } from '../lib/groupCount'
import { relabelResults } from '../lib/schedule'
import { use24HourTime } from '../lib/clock'
import { count, voters } from '../lib/plural'
import { useGroupsInputs } from '../lib/useLeftOut'
import type { GroupsResult, PollResults } from '../lib/types'
import { ChoiceModal } from './ChoiceBlurb'
import { MoreResults } from './MoreResults'
import { RankingSkeleton } from './Skeletons'

/**
 * *Group formation*, opened from the result's *More results* menu
 * (`MoreResults`), or drawn on the results page where the question chose it
 * (`ChosenResult`): the voters split into groups as even in size as can be,
 * as alike or as mixed as can be. `/choices` explains it, and `poll_groups`
 * forms them.
 *
 * **It names who is with whom**, so it is offered only on a poll that shows
 * who voted (`offers`). It says nothing of how far apart anybody is: on a
 * poll whose ballots are private, a group of two's distance would be the
 * distance between two ballots.
 *
 * **The number and the direction are the reader's to change**, on any poll
 * that shows its voters: groups say who voted more alike than whom, never
 * how anybody scored. Held for as long as this poll's results are on screen,
 * never stored. Not on the sample, which answers from a recording.
 *
 * **Each group can make a choice of its own** (*Make choice*): every count
 * *More results* offers, over that group's ballots alone. That does say how
 * its voters scored, so it is only where the ballots are published.
 */
export function GroupFormation({
  source,
  results,
  opened,
  onClose,
}: {
  source: CountSource
  results: PollResults
  opened: boolean
  onClose: () => void
}) {
  // Held here rather than in the body, which is mounted only while open.
  const [inputs, setInputs] = useGroupsInputs(source.pollId, groupsFor(results))

  return (
    <ChoiceModal kind="groups" calendar={results.calendar} opened={opened} onClose={onClose}>
      <GroupFormationBody source={source} results={results} inputs={inputs} onInputs={setInputs} />
    </ChoiceModal>
  )
}

/**
 * The groups themselves, in the modal or on the results page. Handed the
 * grouping the tally carried (`initial`), it asks for nothing until the
 * number or the direction changes.
 */
export function GroupFormationBody({
  source,
  results,
  initial = null,
  inputs,
  onInputs,
}: {
  source: CountSource
  results: PollResults
  initial?: GroupsResult | null
  inputs: { groups: number; similar: boolean }
  onInputs: (next: { groups: number; similar: boolean }) => void
}) {
  const kind = source.kind
  const key = source.pollId
  const sample = isSampleId(key)
  const { groups, similar } = inputs
  const asAsked = initial !== null && initial.group_count === groups && initial.similar === similar

  const [result, setResult] = useState<GroupsResult | null>(asAsked ? initial : null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [view, setView] = useState<'groups' | 'voters'>('groups')

  useEffect(() => {
    setError(null)
    if (asAsked) {
      setResult(initial)
      setLoading(false)
      return
    }

    setLoading(true)
    let cancelled = false
    const args = { p_poll_id: key, p_groups: groups, p_similar: similar }
    const request: PromiseLike<RpcAnswer> =
      kind === 'poll'
        ? supabase.rpc('get_poll_groups', args)
        : openPollRpc('open_poll_groups', args)

    request.then(({ data, error: rpcError }) => {
      if (cancelled) return
      setLoading(false)
      if (rpcError) return setError(rpcError.message)
      const { value, error: shape } = parseAnswer(groupsSchema, 'the groups', data)
      if (value) setResult(value)
      else setError(shape)
    })

    return () => {
      cancelled = true
    }
  }, [kind, key, groups, similar, asAsked, initial])

  // A group's own count reads how its voters scored, so only where the
  // ballots are published (`poll_group_count` refuses the same); and the
  // sample has no group's ballots recorded.
  const canChoose = !sample && results.ballots_shown === true

  return (
    <Stack gap="md">
      <Group gap="sm" align="flex-end" wrap="wrap">
        <Select
          label={choiceNumberLabel('groups', results.calendar)}
          allowDeselect={false}
          w={160}
          disabled={sample}
          value={String(groups)}
          onChange={(v) => v && onInputs({ groups: Number(v), similar })}
          data={CHOICE_NUMBERS.map((n) => String(n))}
        />
        <Select
          label="Group similarity"
          allowDeselect={false}
          w={260}
          maw="100%"
          disabled={sample}
          value={similar ? 'alike' : 'mixed'}
          onChange={(v) => v && onInputs({ groups, similar: v === 'alike' })}
          data={[
            { value: 'alike', label: 'Maximize group similarity' },
            { value: 'mixed', label: 'Minimize group similarity' },
          ]}
        />
      </Group>

      {error && (
        <Text role="alert" c="red" size="sm">
          {error}
        </Text>
      )}

      {!error && !result && <RankingSkeleton places={groups} />}

      {result && (
        <Stack
          gap="md"
          aria-busy={loading}
          style={{ opacity: loading ? 0.5 : 1, transition: 'opacity var(--motion-fast)' }}
        >
          <SegmentedControl
            value={view}
            onChange={(v) => setView(v as 'groups' | 'voters')}
            data={[
              { label: 'Group view', value: 'groups' },
              { label: 'Voter view', value: 'voters' },
            ]}
            style={{ alignSelf: 'flex-start' }}
          />

          {view === 'groups' &&
            result.groups.map((group, i) => {
              const ref: GroupRef = {
                groups: result.group_count,
                similar: result.similar,
                index: i + 1,
              }
              const names = group.voters.map((v) => v.name)
              return (
                <Stack key={`${result.group_count}-${result.similar}-${i}`} gap={2}>
                  <Group gap="xs" wrap="nowrap" align="center">
                    <Text fw={600}>Group {i + 1}</Text>
                    <Text size="sm" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                      {voters(names.length)}
                    </Text>
                    {canChoose && names.length > 0 && !loading && (
                      <Group ml="auto">
                        <MakeChoice source={source} group={ref} names={names} />
                      </Group>
                    )}
                  </Group>
                  <Text size="sm" c={names.length === 0 ? 'dimmed' : undefined}>
                    {names.length === 0 ? 'Nobody' : names.join(', ')}
                  </Text>
                </Stack>
              )
            })}

          {view === 'voters' && <VoterView result={result} />}

          {view === 'groups' && result.not_grouped.length > 0 && (
            <Stack gap={2}>
              <Text size="sm" fw={600}>
                Not grouped
              </Text>
              <Text size="sm" c="dimmed">
                {count(result.not_grouped.length, 'invitee')} did not vote:{' '}
                {result.not_grouped.map((v) => v.name).join(', ')}
              </Text>
            </Stack>
          )}
        </Stack>
      )}
    </Stack>
  )
}

/**
 * Every voter, alphabetically, with the group they are in, and the invitees
 * who did not vote as in none. The answer names voters as the roster does.
 */
function VoterView({ result }: { result: GroupsResult }) {
  const rows = [
    ...result.groups.flatMap((group, i) => group.voters.map((v) => [v.name, `Group ${i + 1}`])),
    ...result.not_grouped.map((v) => [v.name, 'Not grouped (did not vote)']),
  ].sort(([a], [b]) => a.localeCompare(b))

  return (
    <Stack gap="sm">
      {rows.map(([name, where], i) => (
        <Group key={`${name}-${i}`} gap="xs" wrap="nowrap" justify="space-between">
          <Text fw={600} style={{ overflowWrap: 'anywhere' }}>
            {name}
          </Text>
          <Text size="sm" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
            {where}
          </Text>
        </Group>
      ))}
    </Stack>
  )
}

/**
 * One group's *Make choice*: the *More results* menu over that group's
 * ballots. The group's own tally is what the menu decides its offers from and
 * what its modals start from, so it is read on the first press (one request,
 * which forms the groups again) rather than for every group on arrival; the
 * menu then opens as it arrives.
 */
function MakeChoice({
  source,
  group,
  names,
}: {
  source: CountSource
  group: GroupRef
  names: string[]
}) {
  const h24 = use24HourTime()
  const [tally, setTally] = useState<PollResults | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const grouped = { ...source, group }

  function load() {
    setLoading(true)
    setError(null)
    groupCount(grouped, 'results').then(({ data, error: rpcError }) => {
      setLoading(false)
      if (rpcError) return setError(rpcError.message)
      const { value, error: shape } = parseAnswer(pollResultsSchema, 'the group’s tally', data)
      if (value) setTally(relabelResults(value, h24))
      else setError(shape)
    })
  }

  if (tally) {
    return (
      <CountingGroup.Provider value={`Group ${group.index}: ${names.join(', ')}`}>
        <MoreResults
          source={grouped}
          results={tally}
          shown="groups"
          label="Make choice"
          defaultOpened
        />
      </CountingGroup.Provider>
    )
  }

  return (
    <Stack gap={2} align="flex-end">
      <Button
        variant="default"
        size="compact-sm"
        loading={loading}
        onClick={load}
        rightSection={<CaretDownIcon size={14} aria-hidden />}
      >
        Make choice
      </Button>
      {error && (
        <Text role="alert" c="red" size="xs">
          {error}
        </Text>
      )}
    </Stack>
  )
}
