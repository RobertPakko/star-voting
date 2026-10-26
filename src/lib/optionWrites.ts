import { supabase } from './supabase'
import { openPollRpc } from './samplePoll'
import { voterKeyFor } from './voterKey'

/**
 * Which endpoints a list writes through: an invite poll (session), an open
 * poll (link), or the creator correcting a list that is already a ballot.
 */
export type OptionsSource =
  | { kind: 'poll'; pollId: string }
  | { kind: 'open'; pollId: string }
  | { kind: 'creator'; pollId: string }

/**
 * The unsaved edit a list is holding, so the card's closing button (*Confirm
 * options* or *Done*) can save it first: one press, one save. Resolves to
 * whether the save went through; the list reports its own errors. Null when
 * nothing is outstanding.
 */
export type DraftHold = { current: (() => Promise<boolean>) | null }

/** An option as typed: an empty description means none. */
type Typed = { name: string; description: string }

/**
 * Send a draft, typed or painted. The creator's correction is one
 * `creator_edit_options`. A list still collecting is two calls, because two
 * parties write it: corrections and removals through the creator's door first
 * (freeing names and room under the ceiling, in one transaction), then
 * suggestions through the endpoint everyone shares. The plural suggestion
 * endpoints skip names already on the list.
 */
export async function sendDraft(
  source: OptionsSource,
  draft: { added: Typed[]; corrected: (Typed & { id: string })[]; removed: string[] },
) {
  // Null, not '', is what the column holds for no description.
  const added = draft.added.map((o) => ({ name: o.name, description: o.description || null }))
  const corrected = draft.corrected.map((o) => ({
    id: o.id,
    name: o.name,
    description: o.description || null,
  }))

  if (source.kind === 'creator')
    return supabase.rpc('creator_edit_options', {
      p_poll_id: source.pollId,
      p_options: added,
      p_remove: draft.removed,
      p_correct: corrected,
    })

  if (corrected.length > 0 || draft.removed.length > 0) {
    const { error } = await supabase.rpc('creator_edit_options', {
      p_poll_id: source.pollId,
      p_remove: draft.removed,
      p_correct: corrected,
    })
    if (error) return { error }
  }

  if (added.length === 0) return { error: null }

  const body = { p_poll_id: source.pollId, p_options: added }
  return source.kind === 'poll'
    ? supabase.rpc('suggest_options', body)
    : supabase.rpc('open_poll_suggest_options', body)
}

export function sendConfirmation(source: OptionsSource, voterName: string | null) {
  return source.kind === 'poll'
    ? supabase.rpc('confirm_options', { p_poll_id: source.pollId })
    : openPollRpc('open_poll_confirm_options', {
        p_poll_id: source.pollId,
        p_voter_key: voterKeyFor(source.pollId),
        p_voter_name: voterName,
      })
}

export function withdrawConfirmation(source: OptionsSource) {
  return source.kind === 'poll'
    ? supabase.rpc('unconfirm_options', { p_poll_id: source.pollId })
    : openPollRpc('open_poll_unconfirm_options', {
        p_poll_id: source.pollId,
        p_voter_key: voterKeyFor(source.pollId),
      })
}
