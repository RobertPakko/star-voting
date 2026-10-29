import { useEffect, useRef, useState } from 'react'
import { ActionIcon, AppShell, Box, Group, Popover, Stack, Text } from '@mantine/core'
import { GearIcon } from '@phosphor-icons/react'
import { Link, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { BackToHome } from './BackToHome'
import { ClockSwitch } from './ClockSwitch'
import { InstallButton } from './InstallButton'
import { NotificationSwitches } from './NotificationSwitches'
import { pageKey } from '../lib/pollId'
import { LinkPushSwitch } from './PushSwitch'
import { Reveal } from './Reveal'
import { ThemeToggle } from './ThemeToggle'

/**
 * The app shell, wrapped around every page except the sign-in screen;
 * including the ones reachable without an account (the home page and the
 * public voting page). A voter who arrives from a share link is looking at the
 * same site as everyone else and should see the same header: the earlier
 * signed-out version was a small wordmark inline with the content, which
 * read as part of the poll rather than as the site around it.
 *
 * The wordmark links to `/`, the home page, for everybody; the home page is
 * where every other page is linked from, signing in and out included, so the
 * right-hand group is only settings: the install button, the gear (the
 * notification switches and the clock), and the theme menu. Every page but
 * the home page and the poll pages gets *Back to homepage* above it here; a
 * poll page draws its own way back (see PollPage).
 */
export function Layout() {
  const { session, anonymous } = useAuth()
  // Signed in to an account, as opposed to signed in without one: the email
  // shown and the email switch in the gear are an account's.
  const account = session && !anonymous ? session : null
  const { pathname, search } = useLocation()
  const onSettings = pathname === '/settings'
  // The gear menu, held here so that any change of page closes it rather than
  // leaving it open over the page it went to (a switch's *See how* goes to the
  // install guide). The search is watched as well as the path, so that any
  // address differing only in its query closes it too.
  const [menuOpen, setMenuOpen] = useState(false)
  useEffect(() => setMenuOpen(false), [pathname, search])
  // How far the menu is slid right from under the gear, so that its right edge
  // sits on the page's own right gutter rather than on the gear's. Measured on
  // opening, because what stands to the gear's right — the theme menu — is the
  // header's business and could change.
  const controls = useRef<HTMLDivElement>(null)
  const gear = useRef<HTMLButtonElement>(null)
  const [menuShift, setMenuShift] = useState(0)
  function toggleMenu() {
    const edge = controls.current?.getBoundingClientRect().right
    const own = gear.current?.getBoundingClientRect().right
    if (edge !== undefined && own !== undefined) setMenuShift(Math.max(0, edge - own))
    setMenuOpen((open) => !open)
  }

  return (
    <AppShell header={{ height: 60 }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Link
            to="/"
            style={{
              textDecoration: 'none',
              color: 'inherit',
              minWidth: 0,
            }}
          >
            <Group component="span" gap="sm" wrap="nowrap">
              <img
                src={`${import.meta.env.BASE_URL}logo.png`}
                alt="logo"
                width={32}
                height={32}
                style={{ borderRadius: 8, display: 'block' }}
              />
              {/* Drawn as a heading and not one: the wordmark is the same on
                  every page, so as a heading it was the one a screen reader's
                  outline began with everywhere, ahead of the page's own. */}
              <Text
                component="span"
                fw={700}
                fz="var(--mantine-h4-font-size)"
                lh="var(--mantine-h4-line-height)"
              >
                ChoiceLab
              </Text>
            </Group>
          </Link>
          <Group gap="sm" wrap="nowrap" ref={controls}>
            {account && (
              <Text size="sm" c="dimmed" visibleFrom="sm" truncate maw={240}>
                {account.user.email}
              </Text>
            )}
            <InstallButton />
            {/* An icon beside the theme menu, for the same width reason the
                install button is one. It opens the two notification switches
                where they are rather than taking the reader to a page for
                them: two switches do not earn a page, and the reader is
                usually in the middle of a poll. The /settings page still
                exists, for the emails' footer to link to, and the gear stands
                down there, since it would open what is already on screen.
                Signed out it holds one switch, push for this browser, which is
                how a reader holding a link turns on notifications for the open
                polls they answer — the same place an account does it, so every
                banner pointing at it can say the same thing.

                No tooltip: a hover label under a button that opens a menu
                lands on top of the menu it opened. The aria-label still names
                it. The menu is as wide as its switches
                and slid right to meet the page's edge (see menuShift), rather
                than hanging off the gear towards the middle of the page. */}
            {!onSettings && (
              <Popover
                position="bottom-end"
                shadow="md"
                offset={{ mainAxis: 8, crossAxis: menuShift }}
                opened={menuOpen}
                onChange={setMenuOpen}
              >
                <Popover.Target>
                  <ActionIcon
                    ref={gear}
                    variant="outline"
                    color="gray"
                    size="lg"
                    aria-label="Settings"
                    onClick={toggleMenu}
                  >
                    <GearIcon size={18} aria-hidden />
                  </ActionIcon>
                </Popover.Target>
                <Popover.Dropdown maw={280}>
                  <Stack gap="sm">
                    {/* Without an account there is no address to email and
                        no address for an account's push to be sent by (the
                        database picks a poll's devices by email), so that
                        reader gets the link's switch, as signed out. */}
                    {/* The clock is this browser's, not the account's, so the
                        same for every reader (see lib/clock.ts) — but it
                        waits with the account's switches when there are
                        some, so the three arrive together. */}
                    {account ? (
                      <NotificationSwitches userId={account.user.id} withClock />
                    ) : (
                      <>
                        <LinkPushSwitch />
                        <ClockSwitch />
                      </>
                    )}
                  </Stack>
                </Popover.Dropdown>
              </Popover>
            )}
            <ThemeToggle />
          </Group>
        </Group>
      </AppShell.Header>
      {/* Clipped sideways, because a question slides in from beside the one
          it replaced (see QuestionStrip) and a block sliding in from past the
          right-hand edge would otherwise widen the page for as long as it
          takes. `clip` rather than `hidden`, which would make this a scroll
          container and quietly break everything sticky inside it. */}
      <AppShell.Main style={{ overflowX: 'clip' }}>
        {/* Each page fades in as it opens. Keyed by which page it is rather
            than by the address, which is the whole of the care needed here:
            walking between the questions of a poll changes the address
            without changing the page, and the app goes to real trouble to
            keep that crossing mounted so the heading and the strip do not
            blink — see PollPage. A key off `pathname` would have thrown that
            away and re-mounted the poll on every step through it.

            Except a page a poll's heading is flying onto, between a list
            card and a poll's page in either direction: the flight is that
            page's entrance, so the page stops this rise itself before the
            first paint. See `stillEntrances` in lib/headingFlight.ts. */}
        <Reveal key={pageKey(pathname)}>
          {showsBackToHome(pathname) && (
            <Box maw={720} mx="auto">
              <BackToHome />
            </Box>
          )}
          <Outlet />
        </Reveal>
      </AppShell.Main>
    </AppShell>
  )
}

/**
 * Whether this page takes its way home from the shell: every page but the
 * home page itself, a poll (which draws its own way back), and the poll list
 * (which draws it in a row with its own buttons; its archived view goes back
 * to the list, which leads home in turn).
 */
function showsBackToHome(pathname: string): boolean {
  return pathname !== '/' && pathname !== '/polls' && pageKey(pathname) !== '/:pollId'
}
