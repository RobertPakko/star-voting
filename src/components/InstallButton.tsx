import { ActionIcon, Tooltip } from '@mantine/core'
import { DownloadSimpleIcon } from '@phosphor-icons/react'
import { useInstallPrompt } from '../lib/installPrompt'

/**
 * Installs the app to the home screen, on the browsers that have an install
 * dialog to open and have not already opened one that was accepted.
 *
 * An icon rather than a labelled button, because this is the widest the
 * header row ever gets: it appears alongside everything else rather than
 * instead of anything, and at 375px the wordmark is already wrapping to two
 * lines on a signed-out poll page. It sits next to the theme menu rather
 * than in a leading position for the same reason it is an icon at all — it
 * is the one control here that is usually absent, and a gap that opens in
 * the middle of a row is read as a row that has lost something.
 *
 * See `useInstallPrompt` for why there is nothing to draw on iOS.
 */
export function InstallButton() {
  const install = useInstallPrompt()
  if (!install) return null

  return (
    <Tooltip label="Install app" withArrow>
      <ActionIcon
        variant="subtle"
        color="gray"
        size="lg"
        aria-label="Install app"
        onClick={install}
      >
        <DownloadSimpleIcon size={18} aria-hidden />
      </ActionIcon>
    </Tooltip>
  )
}
