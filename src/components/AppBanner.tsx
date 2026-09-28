import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Alert, Anchor } from '@mantine/core'
import { BellRingingIcon } from '@phosphor-icons/react'
import { appBannerDismissed, dismissAppBanner, isInstalledApp, pushState } from '../lib/push'

/**
 * The one place the app says it can be installed and can notify, in passing:
 * on the poll list, and under the card a voter lands on after voting.
 *
 * Both are moments somebody is waiting on other people — for invites to come
 * in, for the rest of the group to vote — which is exactly when "we can tell
 * you" is worth reading. It links to the guide rather than asking for
 * anything, because what to do next is different on every device (see
 * InstallGuide) and a prompt nobody asked for is one browsers suppress.
 *
 * **Closing it is for good**, in this browser: a banner that comes back after
 * being dismissed is a banner people learn to close without reading, which is
 * the fate of the other banners on the page too.
 *
 * It says nothing where there is nothing to do: a build with no push key, a
 * browser with no push at all, a reader who has already said no — only the
 * browser's own settings can undo that, which the guide covers for anybody who
 * goes looking — and a reader who has already said yes.
 */
export function AppBanner() {
  const [shown, setShown] = useState(() => !appBannerDismissed() && worthSaying())
  if (!shown) return null

  // Inside the installed app, installing is done; what is left is the half of
  // the sentence about notifications.
  const installed = isInstalledApp()

  return (
    <Alert
      variant="light"
      icon={<BellRingingIcon size={20} aria-hidden />}
      withCloseButton
      closeButtonLabel="Dismiss for good"
      onClose={() => {
        dismissAppBanner()
        setShown(false)
      }}
    >
      {installed
        ? 'Did you know this app can notify you when there are updates to your polls? '
        : 'Did you know you can install this site as an app and receive notifications when there are updates to your polls? '}
      <Anchor component={Link} to="/app" inherit fw={500}>
        Learn how
      </Anchor>
    </Alert>
  )
}

function worthSaying(): boolean {
  const state = pushState()
  return state === 'ask' || state === 'needs-install'
}
