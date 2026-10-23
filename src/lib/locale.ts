/**
 * What the reader's language says about writing dates and times: which day a
 * week starts on, whether the day comes before the month, and which clock.
 *
 * **Read off the browser's language, never asked.** Hardly anybody looks for
 * "week starts on" or "date order" in a menu, and the language already
 * answers both for nearly everybody — `en-US` starts on Sunday and writes
 * `Sep 18`, `en-GB` starts on Monday and writes `18 Sep`. The clock is the one
 * of the three a reader may well want to override, so it is only a default
 * here and the switch in `clock.ts` has the last word.
 *
 * Read once, at import: a browser's language does not change under a page.
 * All three are display only — a poll's options are ISO 8601 instants and its
 * grid is keyed by date, so two readers with different answers here are
 * reading the same poll.
 */

function language(): string {
  try {
    return typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en-US'
  } catch {
    return 'en-US'
  }
}

const LANGUAGE = language()

/**
 * Regions whose week starts on Sunday or Saturday, from CLDR's week data —
 * the fallback where `Intl.Locale` will not say (Firefox, older Safari).
 * Everywhere else starts on Monday.
 */
const SUNDAY_FIRST = new Set(
  'AG AS BD BR BS BT BW BZ CA CO DM DO ET GT GU HK HN ID IL IN JM JP KE KH KR LA MH MM MO MT MX MZ NI NP PA PE PH PK PR PT PY SA SG SV TH TT TW UM US VE VI WS YE ZA ZW'.split(
    ' ',
  ),
)
const SATURDAY_FIRST = new Set('AE AF BH DJ DZ EG IQ IR JO KW LY OM QA SD SY'.split(' '))

type WeekInfo = { firstDay: number }
type LocaleWithWeek = Intl.Locale & { weekInfo?: WeekInfo; getWeekInfo?: () => WeekInfo }

/** 0 for Sunday, 1 for Monday, 6 for Saturday — the numbering `firstDayOfWeek` takes. */
function weekStart(tag: string): 0 | 1 | 6 {
  try {
    const locale = new Intl.Locale(tag) as LocaleWithWeek
    // `getWeekInfo()` is the standard; `weekInfo` is the getter Chrome shipped first.
    const info = locale.getWeekInfo?.() ?? locale.weekInfo
    // 1 is Monday and 7 is Sunday there.
    if (info) return info.firstDay === 7 ? 0 : info.firstDay === 6 ? 6 : 1
    const region = locale.maximize().region ?? ''
    return SUNDAY_FIRST.has(region) ? 0 : SATURDAY_FIRST.has(region) ? 6 : 1
  } catch {
    return 1
  }
}

/** Whether `tag` writes `18 Sep` rather than `Sep 18`. */
function dayFirst(tag: string): boolean {
  try {
    const parts = new Intl.DateTimeFormat(tag, { month: 'short', day: 'numeric' }).formatToParts(
      new Date(Date.UTC(2026, 8, 18, 12)),
    )
    const day = parts.findIndex((part) => part.type === 'day')
    const month = parts.findIndex((part) => part.type === 'month')
    return day >= 0 && month >= 0 && day < month
  } catch {
    return false
  }
}

/** Whether `tag` reads times as `14:30` rather than `2:30pm`. */
function clock24(tag: string): boolean {
  try {
    return new Intl.DateTimeFormat(tag, { hour: 'numeric' }).resolvedOptions().hour12 === false
  } catch {
    return false
  }
}

/** The day the calendars start their weeks on: 0 Sunday, 1 Monday, 6 Saturday. */
export const WEEK_STARTS_ON = weekStart(LANGUAGE)

/** Whether dates are written day first: `Fri 18 Sep` rather than `Fri Sep 18`. */
export const DAY_BEFORE_MONTH = dayFirst(LANGUAGE)

/** The clock this language reads, before the reader has said otherwise. */
export const PREFERS_24_HOUR = clock24(LANGUAGE)

/** Exported for the tests, which ask about languages other than their own. */
export const forLanguage = (tag: string) => ({
  weekStartsOn: weekStart(tag),
  dayBeforeMonth: dayFirst(tag),
  prefers24Hour: clock24(tag),
})
