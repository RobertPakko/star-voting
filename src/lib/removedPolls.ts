import { useCallback, useEffect, useState } from 'react'
import { supabase } from './supabase'

/**
 * Taking polls off the reader's list, and putting them back.
 *
 * Removing a poll is the account's, not the browser's: it is a row in
 * `removed_polls`, so a poll removed on the laptop is gone from the phone as
 * well, and `list_polls` pages around it rather than leaving a gap where it
 * was. It also stops the account being told about the poll — no email and no
 * push when it opens or finishes — which is what separates *remove* from the
 * browser-only *hide* it replaced. Nothing about the poll itself changes: it is
 * still readable at its own address and still answerable, and nobody else,
 * its creator included, learns anything. See
 * `0077_removing_a_poll_from_your_list.sql`.
 *
 * Both calls take a list because the one-off migration below hands over
 * everything a browser had hidden at once; the page's own buttons pass one.
 * Both announce themselves on the reader's `user:<id>` topic, so the list on
 * every device re-reads itself — this one included, through the live stream,
 * which is why neither caller reads the list again by hand.
 */

export async function removePolls(ids: string[]): Promise<string | null> {
  const { error } = await supabase.rpc('remove_polls', { p_poll_ids: ids })
  return error?.message ?? null
}

export async function restorePolls(ids: string[]): Promise<string | null> {
  const { error } = await supabase.rpc('restore_polls', { p_poll_ids: ids })
  return error?.message ?? null
}

/**
 * The key the browser-only version kept its hidden polls under.
 *
 * Read once, sent up as removals, and deleted, so that a reader who had tidied
 * their list before this moved into the database does not come back to find it
 * untidied. Sent under whichever account is signed in on the browser that did
 * the hiding, which is the nearest thing to an owner those ids ever had; ids
 * that are not on that account's list are skipped by `remove_polls` rather
 * than refused.
 *
 * The key is only deleted once the removal has gone in, so a request that
 * fails is tried again on the next visit rather than losing the list. Nothing
 * goes wrong if it never succeeds: the ids sit in storage doing nothing.
 */
const LEGACY_KEY = 'star-voting:hidden-polls'

export async function migrateHiddenPolls(): Promise<void> {
  let ids: string[]
  try {
    const raw = localStorage.getItem(LEGACY_KEY)
    if (!raw) return
    const parsed: unknown = JSON.parse(raw)
    ids = Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return
  }
  if (ids.length > 0 && (await removePolls(ids)) !== null) return
  try {
    localStorage.removeItem(LEGACY_KEY)
  } catch {
    // Storage that refuses a delete refused the write too; nothing to undo.
  }
}

/**
 * Whether the signed-in reader has removed this poll from their list, for the
 * card they land on after voting or confirming: somebody who removed a poll
 * and then took part in it anyway is not going to hear how it ends, and that
 * card is where to say so. `null` until the database has answered, and false
 * with nobody signed in or no poll to ask about, without asking.
 *
 * `known` is the answer where the page already has it: `poll_page` carries
 * `removed`, so a card under a poll opened by that read asks nothing. Left
 * undefined — a database older than 0083, or a page holding no such read —
 * and it asks for itself, as it always did.
 *
 * The setter is handed back so a restore made from that card can say so at
 * once, rather than waiting for a read nothing would prompt: the answer is
 * read once per card, not kept live, and the setter wins over `known`.
 */
export function usePollRemoved(
  pollId: string | undefined,
  userId: string | undefined,
  known?: boolean,
): [boolean | null, (removed: boolean) => void] {
  const asked = pollId && userId ? `${userId}:${pollId}` : null
  const [answer, setAnswer] = useState<{ asked: string; removed: boolean } | null>(null)
  const told = known !== undefined

  useEffect(() => {
    if (!asked || !pollId || told) return
    let live = true
    supabase.rpc('poll_is_removed', { p_poll_id: pollId }).then(({ data, error }) => {
      // A database older than the function answers with an error, which is
      // the same as nothing removed: nothing can have been.
      if (live) setAnswer({ asked, removed: !error && data === true })
    })
    return () => {
      live = false
    }
  }, [asked, pollId, told])

  const removed = !asked ? false : answer?.asked === asked ? answer.removed : (known ?? null)
  const set = (next: boolean) => {
    if (asked) setAnswer({ asked, removed: next })
  }
  return [removed, set]
}

/**
 * Whether the reader of a poll page removed the poll from their list, as that
 * page's reads say — and as a restore made on the page says after them.
 *
 * `poll_page` carries `removed`, so the page hands it to the card that says so
 * (`Banners`) rather than that card asking. The catch is the reads a page holds
 * for the questions beside the one on screen: they were taken before the reader
 * pressed *Add back to your list*, and a restore is told to the reader's list
 * rather than to the poll, so nothing reads them again. Walking on to the next
 * question would draw one of those and put the banner back. A poll page can
 * only ever restore — removing is the list's — so once one has, the poll it
 * restored stays restored for as long as the page is open, whatever an older
 * read says.
 *
 * `group` is the poll, by the group its questions share (or the question
 * itself, for a poll of one), since a removal is of the whole poll. `heard`
 * takes what a `poll_page` read said; undefined is a database older than
 * 0083, which leaves the card asking for itself.
 */
export function useRemovedHere(group: string | undefined) {
  const [read, setRead] = useState<boolean | undefined>(undefined)
  const [restored, setRestored] = useState<string | null>(null)
  const onRestored = useCallback(() => setRestored(group ?? null), [group])
  return {
    removed: group !== undefined && restored === group ? false : read,
    heard: setRead,
    onRestored,
  }
}
