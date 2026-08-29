import { Fragment } from 'react'

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
 */
export function NameList({ names }: { names: { id: string; name: string }[] }) {
  const last = names.length - 1

  return (
    <>
      {names.map((entry, index) => (
        <Fragment key={entry.id}>
          {index > 0 && (index === last ? ' and ' : ', ')}
          <strong>{entry.name}</strong>
        </Fragment>
      ))}
    </>
  )
}
