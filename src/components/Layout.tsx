import { useEffect, useRef, useState } from 'react'
import {
  ActionIcon,
  Anchor,
  AppShell,
  Button,
  Group,
  Modal,
  Popover,
  Stack,
  Text,
  Title,
} from '@mantine/core'
import { GearIcon, SignInIcon, SignOutIcon } from '@phosphor-icons/react'
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { InstallButton } from './InstallButton'
import { NotificationSwitches } from './NotificationSwitches'
import { LinkPushSwitch } from './PushSwitch'
import { Reveal } from './Reveal'
import { ThemeToggle } from './ThemeToggle'

/**
 * The app shell, wrapped around every page except the sign-in screen;
 * including the ones reachable without an account (the public voting page
 * and `/about`). A voter who arrives from a share link is looking at the
 * same site as everyone else and should see the same header: the earlier
 * signed-out version was a small wordmark inline with the content, which
 * read as part of the poll rather than as the site around it.
 *
 * Only the right-hand group changes with the session. The wordmark links
 * to `/` either way; the poll list signed in, the sign-in screen signed
 * out; which is where a wordmark in the top-left is expected to go.
 *
 * The About link is dropped while About is what's on screen: a link to the
 * page you are already reading is a dead end that still asks to be read,
 * and its absence is the plainest way to say you have arrived.
 */
export function Layout() {
  const { session, signOut } = useAuth()
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const onAbout = pathname === '/about'
  const onSettings = pathname === '/settings'
  // The notification menu, held here so that following its one link — to the
  // install guide, from under a push switch that cannot be turned on — closes
  // it rather than leaving it open over the page it went to.
  const [menuOpen, setMenuOpen] = useState(false)
  useEffect(() => setMenuOpen(false), [pathname])
  // How far the menu is slid right from under the gear, so that its right edge
  // sits on the page's own right gutter rather than on the gear's. Measured on
  // opening, because what stands to the gear's right — the theme menu and
  // sign-out — is the header's business and could change.
  const controls = useRef<HTMLDivElement>(null)
  const gear = useRef<HTMLButtonElement>(null)
  const [menuShift, setMenuShift] = useState(0)
  function toggleMenu() {
    const edge = controls.current?.getBoundingClientRect().right
    const own = gear.current?.getBoundingClientRect().right
    if (edge !== undefined && own !== undefined) setMenuShift(Math.max(0, edge - own))
    setMenuOpen((open) => !open)
  }
  // Signing out asks first. It is an icon now, and an icon a thumb can brush
  // on the way to the theme menu is not one that should end a session on its
  // own: on a phone, getting back in means a trip to the inbox.
  const [confirmingSignOut, setConfirmingSignOut] = useState(false)

  // Off the poll and back to the front door, rather than left standing where
  // the session used to admit them. A page that was rendering the account
  // reading of a poll holds that read until something asks again, and nothing
  // does: the route re-reads on a live signal, not on the session changing.
  // Leaving the address is what makes signing out look like signing out.
  async function handleSignOut() {
    setConfirmingSignOut(false)
    await signOut()
    navigate('/', { replace: true })
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
              <Title order={3} size="h4" style={{ whiteSpace: 'nowrap' }}>
                STAR Voting
              </Title>
            </Group>
          </Link>
          <Group gap="sm" wrap="nowrap" ref={controls}>
            {session && (
              <Text size="sm" c="dimmed" visibleFrom="sm" truncate maw={240}>
                {session.user.email}
              </Text>
            )}
            {/* A plain link rather than a button: it's navigation, not an
                action, and the header has to hold the title without wrapping
                at 375px wide. */}
            {!onAbout && (
              <Anchor component={Link} to="/about" size="sm" style={{ whiteSpace: 'nowrap' }}>
                About
              </Anchor>
            )}
            <InstallButton />
            {/* An icon beside the theme menu, for the same width reason the
                install button is one. It opens the two notification switches
                where they are rather than taking the reader to a page for
                them: two switches do not earn a page, and the reader is
                usually in the middle of a poll. The /settings page still
                exists, for the emails' footer to link to, and the gear stands
                down there the way the About link does on About. Signed out it
                holds one switch, push for this browser, which is how a reader
                holding a link turns on notifications for the open polls they
                answer — the same place an account does it, so every banner
                pointing at it can say the same thing.

                No tooltip, here or on sign-out: a hover label under a button
                that opens a menu lands on top of the menu it opened. The
                aria-label still names it. The menu is as wide as its switches
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
                    aria-label="Notification settings"
                    onClick={toggleMenu}
                  >
                    <GearIcon size={18} aria-hidden />
                  </ActionIcon>
                </Popover.Target>
                <Popover.Dropdown maw={280}>
                  {session ? <NotificationSwitches userId={session.user.id} /> : <LinkPushSwitch />}
                </Popover.Dropdown>
              </Popover>
            )}
            <ThemeToggle />
            {/* One slot, two states. Signed out this is an offer rather than a
                gate — voting on an open poll needs no account — but it has to
                be visible to be taken. Signed in it is the way back off a
                shared device, which is the case this app actually has: a link
                pasted into a family thread is opened on somebody else's phone,
                and without this the first account to sign in there owns the
                app for good. Signed in it is an icon, like its neighbours:
                with the settings gear beside it the row ran out of room on a
                phone, and leaving is not what anybody came to do. Signed out
                it keeps its words, because an offer has to say what it is —
                except on a phone, where the gear beside it (push for a reader
                holding a link) left no room for them and the wordmark was
                wrapping onto two lines. There it is the door-and-arrow icon,
                the mirror of sign-out's, in the accent colour rather than
                grey so it still reads as the one thing being offered. */}
            {session ? (
              <ActionIcon
                variant="outline"
                color="gray"
                size="lg"
                aria-label="Sign out"
                onClick={() => setConfirmingSignOut(true)}
              >
                <SignOutIcon size={18} aria-hidden />
              </ActionIcon>
            ) : (
              <>
                <Button component={Link} to="/" variant="outline" size="sm" visibleFrom="xs">
                  Sign in
                </Button>
                <ActionIcon
                  component={Link}
                  to="/"
                  variant="outline"
                  size="lg"
                  aria-label="Sign in"
                  hiddenFrom="xs"
                >
                  <SignInIcon size={18} aria-hidden />
                </ActionIcon>
              </>
            )}
          </Group>
        </Group>
      </AppShell.Header>
      <Modal
        opened={confirmingSignOut}
        onClose={() => setConfirmingSignOut(false)}
        title={<Text fw={600}>Sign out?</Text>}
        centered
      >
        <Stack gap="md">
          <Text size="sm">
            {session?.user.email ? (
              <>
                You are signed in as <strong>{session.user.email}</strong>. To sign back in you will
                need a new link or code from your inbox.
              </>
            ) : (
              'To sign back in you will need a new link or code from your inbox.'
            )}
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setConfirmingSignOut(false)}>
              Cancel
            </Button>
            <Button onClick={() => void handleSignOut()}>Sign out</Button>
          </Group>
        </Stack>
      </Modal>
      <AppShell.Main>
        {/* Each page fades in as it opens. Keyed by which page it is rather
            than by the address, which is the whole of the care needed here:
            walking between the questions of a poll changes the address
            without changing the page, and the app goes to real trouble to
            keep that crossing mounted so the heading and the strip do not
            blink — see PollPage. A key off `pathname` would have thrown that
            away and re-mounted the poll on every step through it. */}
        <Reveal key={pageKey(pathname)}>
          <Outlet />
        </Reveal>
      </AppShell.Main>
    </AppShell>
  )
}

/**
 * Which page an address is, as opposed to which poll.
 *
 * Every poll is one page — the address carries the poll's id because a poll's
 * link is its id, and each of a poll's questions has an address of its own —
 * so all of them answer to one key and moving between them opens nothing.
 * `/polls/new` is the create form and genuinely another page, which is why it
 * is named rather than swept in with the rest.
 */
function pageKey(pathname: string): string {
  return pathname.startsWith('/polls/') && pathname !== '/polls/new' ? '/polls/:pollId' : pathname
}
