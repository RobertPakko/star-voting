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
 * Both calls take a list, though the page's own buttons pass one. Both announce themselves on the reader's `user:<id>` topic, so the list on
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
 * Whether the signed-in reader has removed this poll from their list, for the
 * card they land on after voting or confirming: somebody who removed a poll
 * and then took part in it anyway is not going to hear how it ends, and that
 * card is where to say so. `null` until the database has answered, and false
 * with nobody signed in or no poll to ask about, without asking.
 *
 * `known` is the answer where the page already has it: `poll_page` carries
 * `removed`, so a card under a poll opened by that read asks nothing. Left
 * undefined — a page holding no such read — and it asks for itself.
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
      // An error reads as not removed: the banner is advice, not a guard.
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
 * takes what a `poll_page` read said; until one has, the card asks for itself.
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
