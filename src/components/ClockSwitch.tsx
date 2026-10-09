import { Switch } from '@mantine/core'
import { set24HourTime, use24HourTime } from '../lib/clock'

/**
 * Whether times are written `14:30` or `2:30pm`, for this browser.
 *
 * Beside the notification switches in the gear menu, and on /settings, which
 * is the one page the gear stands down on. Unlike those it is the same for
 * everybody, signed in or not: it is kept in this browser rather than on an
 * account (see `lib/clock.ts`), so it needs nothing read before it can be
 * drawn and saves as it is flipped.
 */
export function ClockSwitch() {
  const h24 = use24HourTime()
  return (
    <Switch
      label="24-hour time"
      checked={h24}
      onChange={(event) => set24HourTime(event.currentTarget.checked)}
    />
  )
}
