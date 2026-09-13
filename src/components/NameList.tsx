import { Fragment } from 'react'
import { count } from '../lib/plural'

/**
 * A run of option names read back inside a sentence: **A**, **B** and **C**.
 *
 * The results page names groups of options in four places — who tied, who
 * advanced, on the tally and again in the full ranking — and each one wrote
 * its own joiner. Two of them used `' and '` between every pair and two used
 * `', '`, so a three-way tie read "Paddington 2 and Spirited Away and The
 * Matrix" in one sentence and "Spirited Away, Paddington 2" in the next.
 * Both are wrong the same way: a list of names is commas up to the last gap
 * and "and" across it, whichever sentence it is in.
 *
 * Bold, because these are the options themselves rather than the prose
 * around them, which is how all four sites already drew them.
 *
 * `max` cuts the run short at that many names and finishes it with the count
 * of the rest: **A**, **B** and 28 others. For the one of these sentences
 * that can be given a group of any size — a schedule poll's windows tie at
 * the top score readily, and every one of them is named in the line saying
 * what tied — where the sentence is there to say *that* a large group was
 * level, and naming thirty windows inside it says that less well than
 * counting them. Left off everywhere else: the names are the sentence.
 */
export function NameList({ names, max }: { names: { id: string; name: string }[]; max?: number }) {
  const shown = max !== undefined && names.length > max ? names.slice(0, max) : names
  const rest = names.length - shown.length
  const last = shown.length - 1

  return (
    <>
      {shown.map((entry, index) => (
        <Fragment key={entry.id}>
          {index > 0 && (index === last && rest === 0 ? ' and ' : ', ')}
          <strong>{entry.name}</strong>
        </Fragment>
      ))}
      {rest > 0 && ` and ${count(rest, 'other')}`}
    </>
  )
}
