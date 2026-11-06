import { useState } from 'react'
import type { LeftOut } from '../components/RemovedOptions'

/**
 * The options a reader has taken out of a count (*Multiple winners*,
 * *Fractional winners*), for one poll: another poll's removals mean nothing,
 * so a new poll starts with none. Held by whoever outlives the count's body —
 * the modal's wrapper, or the results page — so closing the modal loses
 * nothing.
 */
export function useLeftOut(pollId: string) {
  const [leftOut, setLeftOut] = useState<LeftOut[]>([])
  const [leftOutFor, setLeftOutFor] = useState(pollId)
  if (leftOutFor !== pollId) {
    setLeftOutFor(pollId)
    setLeftOut([])
  }
  return [leftOut, setLeftOut] as const
}
