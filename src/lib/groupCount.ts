import { createContext } from 'react'
import { supabase } from './supabase'
import { openPollRpc, type RpcAnswer } from './samplePoll'

/**
 * One group of a grouping (*Group formation*), as *Make choice* names it: how
 * many groups, which way they were formed, and its place among them, counted
 * from 1 in the order they are shown. The database forms the groups again
 * from these and counts that group's ballots alone, so a reader can count
 * only a group the grouping makes, never ballots of their choosing.
 */
export interface GroupRef {
  groups: number
  similar: boolean
  index: number
}

/**
 * A results card's door, with the group it counts where it counts one.
 * Without a group every card reads the whole poll, as it always has.
 */
export type CountSource = { kind: 'poll' | 'open'; pollId: string; group?: GroupRef }

/** The counts *Make choice* can run over a group, by `poll_group_count`'s names. */
export type GroupCount =
  | 'results'
  | 'ranking'
  | 'multiple_winners'
  | 'fractional_winners'
  | 'consensus'
  | 'consensus_winners'
  | 'budget'
  | 'assignment'
  | 'scores'

/**
 * A source's group as a string, so an effect can depend on it and read
 * another group again; `groupFromKey` turns it back.
 */
export const groupKeyOf = (source: CountSource) =>
  source.group ? `${source.group.groups}:${source.group.similar}:${source.group.index}` : ''

/** The group `groupKeyOf` wrote, or none for ''. */
export function groupFromKey(key: string): GroupRef | undefined {
  if (!key) return undefined
  const [groups, similar, index] = key.split(':')
  return { groups: Number(groups), similar: similar === 'true', index: Number(index) }
}

/**
 * One group's count, through the door its source reads by
 * (`get_poll_group_count` / `open_poll_group_count`). `args` are what the
 * whole poll's own door for that count takes, less the poll id.
 */
export function groupCount(
  source: CountSource & { group: GroupRef },
  count: GroupCount,
  args: Record<string, unknown> = {},
): PromiseLike<RpcAnswer> {
  const { p_poll_id: _poll, ...rest } = args
  const body = {
    p_poll_id: source.pollId,
    p_groups: source.group.groups,
    p_similar: source.group.similar,
    p_group: source.group.index,
    p_count: count,
    p_args: JSON.parse(JSON.stringify(rest)),
  }
  return source.kind === 'poll'
    ? supabase.rpc('get_poll_group_count', body)
    : openPollRpc('open_poll_group_count', body)
}

/**
 * A count over a source: one group's where the source names one, otherwise
 * `whole`, the card's own request for the whole poll.
 */
export function countFor(
  source: CountSource,
  count: GroupCount,
  args: Record<string, unknown>,
  whole: () => PromiseLike<RpcAnswer>,
): PromiseLike<RpcAnswer> {
  return source.group ? groupCount({ ...source, group: source.group }, count, args) : whole()
}

/**
 * The group a *Make choice* modal counts, as its modal says it under the
 * kind's sentence ("Group 2: Ann, Bo and Cy"), so a reader with several open
 * one after another knows whose ballots each is. Null everywhere else.
 */
export const CountingGroup = createContext<string | null>(null)
