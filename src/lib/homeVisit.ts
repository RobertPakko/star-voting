/*
 * Whether this browser has ever opened the home page, which decides whether a
 * poll points the reader there (`HomeBanner` in components/Banners.tsx).
 */
import { readFlag, writeFlag } from './storage'

const HOME_VISITED_KEY = 'star-voting:visited-home'
const HOME_BANNER_KEY = 'star-voting:home-banner-dismissed'

/** Called by the home page on every visit. */
export function noteHomeVisited(): void {
  writeFlag(HOME_VISITED_KEY, true)
}

/** Whether the banner pointing at the home page should be drawn here. */
export function wantsHomeBanner(): boolean {
  return !readFlag(HOME_VISITED_KEY) && !readFlag(HOME_BANNER_KEY)
}

/** *Don't show again* on that banner. */
export function dismissHomeBanner(): void {
  writeFlag(HOME_BANNER_KEY, true)
}
