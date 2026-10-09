import { useEffect } from 'react'
import { announce } from './announce'

/**
 * What the tab says when no page has said anything: while the app boots, on a
 * page still waiting for the poll it is about, and on the intro, which is the
 * app introducing itself.
 */
export const APP_TITLE = 'STAR Voting'

/** The last title a page set, which is what tells a navigation from a load. */
let previous: string | null = null

/**
 * Names the tab after the page on screen: the poll's own title on a poll, and
 * a word or two everywhere else.
 *
 * **Just the name, with no "· STAR Voting" after it.** The favicon beside it
 * already says which site this is, and a tab is narrow: "Movie night" is the
 * part a reader is looking for among ten others, so it is the whole of it.
 *
 * **One page, one caller.** A poll's title is set by `PollHeading` (and by the
 * shape standing in for it while it loads) rather than by each of the pages
 * drawing one, so the two readings of a poll cannot name it differently.
 * `null` sets nothing, for a component that only sometimes owns the title.
 *
 * **A change of title is said aloud.** A screen reader is told nothing when a
 * single-page app changes page — no load, no new document — so the new name is
 * announced, which is what a reader would have heard as the page loaded. Only
 * on a change: the page a reader arrives on is read by the browser, and the
 * same title set twice (walking between the questions of one poll) is no news.
 */
export function usePageTitle(title: string | null | undefined) {
  useEffect(() => {
    if (!title) return
    document.title = title
    if (previous !== null && previous !== title) announce(title)
    previous = title
    return () => {
      // Back to the app's name only if nothing has named the tab since, so a
      // page that is being replaced cannot blank the title of the page that
      // replaced it.
      if (document.title === title) document.title = APP_TITLE
    }
  }, [title])
}
