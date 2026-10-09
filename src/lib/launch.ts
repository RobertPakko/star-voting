import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

/**
 * What the installed app does when the system opens it while it is already
 * open: a tap on its icon, one of its shortcuts (a long press on the icon),
 * or a link the system hands to the app rather than the browser.
 *
 * The manifest's `launch_handler` asks for `focus-existing`: the window that
 * is already open comes forward rather than a second copy of the app opening
 * beside it, holding a second session and a second socket. Without anything
 * more that is all it does, so a shortcut to *New poll* would bring the app
 * forward on whatever page it was showing. So the launch is handed to this
 * page as well, through `window.launchQueue`, and the page routes there
 * itself, without a reload.
 *
 * **A launch with no route in it is the icon**, and moves nothing: tapping the
 * app's icon means *show me the app*, and throwing away the poll somebody had
 * open to land them on their list would be the one thing a native app never
 * does. Every address inside the app carries a hash, the start URL does not,
 * and a shortcut to the list says `#/` for exactly this reason.
 *
 * Chromium on Android and the desktop reads all of this; Safari reads none of
 * it and opens the app as it always has.
 */
interface LaunchParams {
  readonly targetURL?: string
}

interface LaunchQueue {
  setConsumer(consumer: (params: LaunchParams) => void): void
}

export function useLaunchRoutes(): void {
  const navigate = useNavigate()
  useEffect(() => {
    const queue = (window as Window & { launchQueue?: LaunchQueue }).launchQueue
    queue?.setConsumer(({ targetURL }) => {
      if (!targetURL) return
      const hash = new URL(targetURL).hash
      if (!hash.startsWith('#/')) return
      // A fresh window was opened on this address already, and the launch is
      // reported to it too: no second entry for the back button to walk.
      if (window.location.hash === hash) return
      navigate(hash.slice(1))
    })
  }, [navigate])
}
