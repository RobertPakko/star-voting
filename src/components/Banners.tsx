import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Alert, Button, Group, Stack, Text } from '@mantine/core'
import { BellRingingIcon, BellSlashIcon, DownloadSimpleIcon, GearIcon } from '@phosphor-icons/react'
import { useAuth } from '../lib/auth'
import {
  appBannerDismissed,
  dismissAppBanner,
  dismissNotifyHint,
  isInstalledApp,
  notifyHintDismissed,
  pushState,
  usePushHere,
} from '../lib/push'
import { restorePolls, usePollRemoved } from '../lib/removedPolls'

/**
 * The two things the app suggests in passing: that it can notify you, and
 * that it installs as an app. Drawn together, in the same three places — the
 * poll list, under the card a reader lands on after confirming the options,
 * and under the card after voting — because those are the moments somebody
 * is waiting on other people, which is when "we can tell you" and "this can
 * live on your home screen" are worth reading.
 *
 * The same for every reader, signed in or holding a link: push is turned on
 * from the gear menu either way (see LinkPushSwitch), so one sentence says
 * where.
 *
 * Each is its own banner and each goes on its own terms; see the two below.
 *
 * Under a poll (`pollId`), a third comes first for a reader who removed that
 * poll from their list and answered it anyway: they will hear nothing about
 * it, which is the one thing worth knowing while they wait, so it says so and
 * offers the poll back — and the push banner stands down, since turning push
 * on would not reach a poll their account has asked to hear nothing about.
 */
export function Banners({ moment, pollId }: { moment?: 'opening' | 'results'; pollId?: string }) {
  const { session } = useAuth()
  const [removed, setRemoved] = usePollRemoved(pollId, session?.user.id)

  return (
    <>
      {removed && pollId && <RemovedBanner pollId={pollId} onRestored={() => setRemoved(false)} />}
      {/* Held back until the answer is in, rather than drawn and then taken
          away a moment later. */}
      {removed === false && <PushBanner moment={moment} />}
      <InstallBanner />
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
          You removed this poll from your list, so you won&rsquo;t get emails or notifications about
          it.
        </Text>
        {error && (
          <Text size="sm" c="red">
            {error}
          </Text>
        )}
        <Group gap="xs">
          <Button size="xs" variant="light" color="yellow" loading={busy} onClick={restore}>
            Add back to your list
          </Button>
        </Group>
      </Stack>
    </Alert>
  )
}

/**
 * Where the push switch is, until push is on here. It goes the moment the
 * switch is turned on (`usePushHere`, live), rather than on the next page
 * load.
 *
 * Shown where the browser can be asked, and also on an iPhone in a Safari
 * tab: the gear's switch is disabled there with a line saying to install the
 * app first, which is the answer to "how do I get notified" on that device,
 * and the install banner beside this one is how. Nothing where the browser has
 * said no, has no push at all, or the build has none.
 */
function PushBanner({ moment }: { moment?: 'opening' | 'results' }) {
  const { session } = useAuth()
  const pushHere = usePushHere(session?.user.id)
  const state = pushState()
  const relevant = state === 'ask' || state === 'granted' || state === 'needs-install'
  const when =
    moment === 'opening'
      ? 'when voting opens'
      : moment === 'results'
        ? 'when the results are ready'
        : 'when there are updates to your polls'

  if (!relevant || pushHere) return null

  return (
    <Banner
      icon={<BellRingingIcon size={20} aria-hidden />}
      forgotten={notifyHintDismissed}
      forget={dismissNotifyHint}
    >
      Turn on push notifications from the{' '}
      <GearIcon size={14} role="img" aria-label="gear" style={{ verticalAlign: '-2px' }} /> menu to
      be notified {when}.
    </Banner>
  )
}

/**
 * That the site installs as an app, to anybody not already in it. It says
 * nothing about notifications, which the banner beside it covers; an
 * installed app is worth having without them.
 */
function InstallBanner() {
  if (isInstalledApp()) return null

  return (
    <Banner
      icon={<DownloadSimpleIcon size={20} aria-hidden />}
      forgotten={appBannerDismissed}
      forget={dismissAppBanner}
    >
      You can install this site as an app for easier access and better notifications.
    </Banner>
  )
}

/**
 * One banner's shape, so the two cannot drift apart: the sentence, then
 * *Learn more* — the install guide, which covers both installing and turning
 * notifications on for every kind of device — and *Don't show again*.
 *
 * **Two ways to close it, because they mean different things.** The × puts it
 * away for now: it is gone from this page and back the next time the reader
 * is waiting on somebody, which is what a reader who has not decided yet
 * wants. *Don't show again* is the decision, remembered in this browser, and
 * the banner is never drawn here again.
 */
function Banner({
  icon,
  forgotten,
  forget,
  children,
}: {
  icon: ReactNode
  /** Whether *Don't show again* has been pressed in this browser. */
  forgotten: () => boolean
  forget: () => void
  children: ReactNode
}) {
  const [shown, setShown] = useState(() => !forgotten())
  if (!shown) return null

  return (
    <Alert
      variant="light"
      icon={icon}
      withCloseButton
      closeButtonLabel="Close"
      onClose={() => setShown(false)}
    >
      <Stack gap="xs">
        <Text size="sm">{children}</Text>
        <Group gap="xs">
          <Button component={Link} to="/app" size="xs" variant="light">
            Learn more
          </Button>
          <Button
            size="xs"
            variant="subtle"
            color="gray"
            onClick={() => {
              forget()
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
