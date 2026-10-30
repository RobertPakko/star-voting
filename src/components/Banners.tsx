import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Alert, Button, Group, Stack, Text } from '@mantine/core'
import {
  ArrowCounterClockwiseIcon,
  BellSlashIcon,
  EyeSlashIcon,
  HouseIcon,
} from '@phosphor-icons/react'
import { useAuth } from '../lib/auth'
import { restorePolls, usePollRemoved } from '../lib/removedPolls'
import { dismissHomeBanner, wantsHomeBanner } from '../lib/homeVisit'

/**
 * What a poll says in passing, under the card a reader lands on after
 * confirming the options and under the card after voting — the moments
 * somebody is waiting on other people.
 *
 * For a reader who removed the poll from their list and answered it anyway,
 * that they will hear nothing about it, with the way back (`RemovedBanner`).
 *
 * For a reader who has only ever come in by a poll's link, that the site has
 * a front door (`HomeBanner`).
 */
export function Banners({
  pollId,
  removed: known,
  onRestored,
}: {
  pollId: string
  /**
   * Whether the reader removed `pollId`, where the page's read already said —
   * `poll_page` carries it. Undefined is this asking for itself.
   */
  removed?: boolean
  /** Told when the reader puts the poll back from here; see `useRemovedHere`. */
  onRestored?: () => void
}) {
  const { session } = useAuth()
  const [removed, setRemoved] = usePollRemoved(pollId, session?.user.id, known)

  return (
    <>
      {removed && (
        <RemovedBanner
          pollId={pollId}
          onRestored={() => {
            setRemoved(false)
            onRestored?.()
          }}
        />
      )}
      <HomeBanner />
    </>
  )
}

/**
 * That this poll is off the reader's list and silent, and the way back. Only
 * the × closes it, and only for now: it is not advice to be done with but a
 * fact about this poll, true for as long as the poll stays removed.
 */
function RemovedBanner({ pollId, onRestored }: { pollId: string; onRestored: () => void }) {
  const [shown, setShown] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!shown) return null

  async function restore() {
    setBusy(true)
    setError(null)
    const failed = await restorePolls([pollId])
    setBusy(false)
    if (failed) setError(failed)
    else onRestored()
  }

  return (
    <Alert
      variant="light"
      color="yellow"
      icon={<BellSlashIcon size={20} aria-hidden />}
      withCloseButton
      closeButtonLabel="Close"
      onClose={() => setShown(false)}
    >
      <Stack gap="xs">
        <Text size="sm">
          You archived this poll, so you won&rsquo;t get emails or notifications about it.
        </Text>
        {error && (
          <Text role="alert" size="sm" c="red">
            {error}
          </Text>
        )}
        <Group gap="xs">
          <Button
            size="xs"
            variant="light"
            color="yellow"
            loading={busy}
            onClick={restore}
            leftSection={<ArrowCounterClockwiseIcon size={14} aria-hidden />}
          >
            Add back to your list
          </Button>
        </Group>
      </Stack>
    </Alert>
  )
}

/**
 * That there is more to the site than this poll, to a browser that has never
 * opened the home page — somebody who came in by a link they were sent. The
 * × puts it away for now; *Don't show again*, or a visit to the home page, for
 * good in this browser.
 */
function HomeBanner() {
  const [shown, setShown] = useState(wantsHomeBanner)
  if (!shown) return null

  return (
    <Alert
      variant="light"
      icon={<HouseIcon size={20} aria-hidden />}
      withCloseButton
      closeButtonLabel="Close"
      onClose={() => setShown(false)}
    >
      <Stack gap="xs">
        <Text size="sm">
          Interested in this app? Visit the home page to learn more and make your own polls.
        </Text>
        <Group gap="xs">
          <Button
            component={Link}
            to="/"
            size="xs"
            variant="light"
            leftSection={<HouseIcon size={14} aria-hidden />}
          >
            Visit the home page
          </Button>
          <Button
            size="xs"
            variant="subtle"
            color="gray"
            leftSection={<EyeSlashIcon size={14} aria-hidden />}
            onClick={() => {
              dismissHomeBanner()
              setShown(false)
            }}
          >
            Don&rsquo;t show again
          </Button>
        </Group>
      </Stack>
    </Alert>
  )
}
