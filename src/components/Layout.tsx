import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ActionIcon,
  AppShell,
  Button,
  Divider,
  Group,
  Modal,
  Popover,
  Stack,
  Text,
} from '@mantine/core'
import {
  ArchiveIcon,
  BookOpenIcon,
  DownloadSimpleIcon,
  GearIcon,
  PlayCircleIcon,
  SignOutIcon,
  type Icon,
} from '@phosphor-icons/react'
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { ClockSwitch } from './ClockSwitch'
import { InstallButton } from './InstallButton'
import { NotificationSwitches } from './NotificationSwitches'
import { isInstalledApp } from '../lib/push'
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
 * out; which is where a wordmark in the top-left is expected to go. A
 * session made without an account has a poll list, so its wordmark goes
 * there too, and its corner says Sign in rather than offering a sign-out
 * that would strand every poll it made.
 *
 * The pages that are not polls — the removed polls, the install guide, About
 * and the intro — are links in the gear menu rather than in the header. About
 * was a link of its own up here once, and the row is one control shorter on a
 * phone without it. Each is dropped from the menu while it is what's on
 * screen: a link to the page you are already reading is a dead end that
 * still asks to be read, and its absence is the plainest way to say you have
 * arrived.
 */
export function Layout() {
  const { session, anonymous, signOut } = useAuth()
  // Signed in to an account, as opposed to signed in without one: the email
  // shown, the email switch in the gear, and signing out are an account's.
  const account = session && !anonymous ? session : null
  const { pathname, search } = useLocation()
  const navigate = useNavigate()
  const onSettings = pathname === '/settings'
  // The gear menu, held here so that following any of its links — the install
  // guide, the removed polls — closes it rather than leaving it open over the
  // page it went to. The search is watched as well as the path, since the
  // removed polls are the poll list's own address with a query on it.
  const [menuOpen, setMenuOpen] = useState(false)
  useEffect(() => setMenuOpen(false), [pathname, search])
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
              {/* Drawn as a heading and not one: the wordmark is the same on
                  every page, so as a heading it was the one a screen reader's
                  outline began with everywhere, ahead of the page's own. */}
              <Text
                component="span"
                fw={700}
                fz="var(--mantine-h4-font-size)"
                lh="var(--mantine-h4-line-height)"
              >
                STAR Voting
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
                down there the way its own About link does on About. Signed out it
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
                    {account ? (
                      <NotificationSwitches userId={account.user.id} />
                    ) : (
                      <LinkPushSwitch />
                    )}
                    {/* This browser's, not the account's, so the same for
                        every reader; see lib/clock.ts. */}
                    <ClockSwitch />
                    <Divider />
                    {/* Pages rather than switches, so they sit under the
                        switches and apart from them. All are links: the menu
                        closes on any change of address, and each is two words. The reader's own
                        things first, then the app's, then the method's. */}
                    {session && (
                      <MenuLink to="/?removed" icon={ArchiveIcon}>
                        Removed polls
                      </MenuLink>
                    )}
                    {!isInstalledApp() && pathname !== '/app' && (
                      <MenuLink to="/app" icon={DownloadSimpleIcon}>
                        App installation
                      </MenuLink>
                    )}
                    {pathname !== '/about' && (
                      <MenuLink to="/about" icon={BookOpenIcon}>
                        About STAR
                      </MenuLink>
                    )}
                    <MenuLink to="/intro" icon={PlayCircleIcon}>
                      View intro
                    </MenuLink>
                  </Stack>
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
                it keeps its words, because an offer has to say what it is — on
                a phone too, where that costs the wordmark a second line: being
                asked to sign in is worth more than the title fitting on one. */}
            {account ? (
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
              // Without an account the sign-in screen has an address of its
              // own, since `/` is that reader's poll list; it is told where
              // they were, to bring them back there.
              <Button
                component={Link}
                to={anonymous ? '/sign-in' : '/'}
                state={anonymous ? { from: pathname + search } : undefined}
                variant="outline"
                size="sm"
              >
                Sign in
              </Button>
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
          <Outlet />
        </Reveal>
      </AppShell.Main>
    </AppShell>
  )
}

/** One of the gear menu's links to a page. */
function MenuLink({ to, icon: Glyph, children }: { to: string; icon: Icon; children: ReactNode }) {
  return (
    <Button
      component={Link}
      to={to}
      variant="subtle"
      color="gray"
      justify="flex-start"
      leftSection={<Glyph size={18} aria-hidden />}
    >
      {children}
    </Button>
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
