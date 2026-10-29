import { useLayoutEffect, useRef } from 'react'
import { useLocation, useNavigationType } from 'react-router-dom'
import { pageKey } from '../lib/pollId'

/**
 * Opens every page at its top. A single-page app keeps the document it
 * navigated in, so without this a page opened from halfway down the home page
 * arrived already scrolled by however far the reader had gone there.
 *
 * Only on going somewhere new: back and forward (`POP`) are left to the
 * browser, and walking between a poll's questions is not a change of page
 * (`pageKey`). The archived view of the list counts as a page of its own.
 *
 * Rendered ahead of the routes, so its layout effect runs before theirs: the
 * poll list restoring the scroll it was left at, on the way back from a poll,
 * comes after this and wins.
 */
export function ScrollToTop() {
  const { pathname, search } = useLocation()
  const navigationType = useNavigationType()
  const page = pageKey(pathname) + search
  const last = useRef(page)

  useLayoutEffect(() => {
    if (page === last.current) return
    last.current = page
    if (navigationType !== 'POP') window.scrollTo(0, 0)
  }, [page, navigationType])

  return null
}
