import { Button, Menu } from '@mantine/core'
import { CalendarPlusIcon } from '@phosphor-icons/react'
import {
  downloadIcs,
  googleCalendarUrl,
  icsFile,
  icsFileName,
  outlookCalendarUrl,
  type MeetingEvent,
} from '../lib/calendarEvent'

/**
 * Put the time a poll settled on into the reader's own calendar.
 *
 * A menu rather than one button, because there is no one way: Google and
 * Outlook on the web each have a "new event" form a link can fill in, and
 * everything else -- Apple Calendar, desktop Outlook, a phone's own calendar
 * -- takes an `.ics` file. Each of the three shows the event before saving it.
 * See lib/calendarEvent.ts.
 *
 * Draws nothing for a start that is not a window, rather than a menu whose
 * every item is broken.
 */
export function AddToCalendar({ event }: { event: MeetingEvent }) {
  const google = googleCalendarUrl(event)
  const outlook = outlookCalendarUrl(event)
  if (!google || !outlook) return null

  return (
    <Menu position="bottom-end" withinPortal>
      <Menu.Target>
        <Button
          variant="default"
          size="compact-sm"
          leftSection={<CalendarPlusIcon size={16} aria-hidden />}
        >
          Add to calendar
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Item component="a" href={google} target="_blank" rel="noopener noreferrer">
          Google Calendar
        </Menu.Item>
        <Menu.Item component="a" href={outlook} target="_blank" rel="noopener noreferrer">
          Outlook.com
        </Menu.Item>
        <Menu.Item
          onClick={() => {
            const text = icsFile(event)
            if (text) downloadIcs(text, icsFileName(event.title))
          }}
        >
          Apple Calendar or other (.ics)
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  )
}
