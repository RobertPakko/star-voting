import { useEffect } from 'react'
import { useComputedColorScheme } from '@mantine/core'

// --mantine-color-body for each scheme: white, and dark-7. Written out
// because a <meta> takes a colour, not a custom property, and read from the
// same two values by the inline script in index.html that sets the tag before
// the bundle gets here.
const BODY = { light: '#ffffff', dark: '#242424' } as const

/**
 * Keeps `<meta name="theme-color">` on the scheme the app is actually
 * showing.
 *
 * Installed to the home screen, the app has no browser chrome and the strip
 * behind the status bar is coloured by this tag — so getting it wrong is not
 * a browser detail, it is a white bar across the top of a dark app. The
 * media-query form of the tag can't do the job either: it follows the OS,
 * and the theme menu is free to disagree with the OS.
 *
 * Rendered inside MantineProvider and outside the router, because the choice
 * outlives every page, including the sign-in screen that sits outside the app
 * shell.
 */
export function ThemeColorMeta() {
  const computed = useComputedColorScheme('light', { getInitialValueInEffect: false })

  useEffect(() => {
    const meta = document.querySelector('meta[name="theme-color"]')
    meta?.setAttribute('content', BODY[computed])
  }, [computed])

  return null
}
