import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  Anchor,
  Button,
  Card,
  Group,
  List,
  SegmentedControl,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core'
import { CheckIcon, DownloadSimpleIcon } from '@phosphor-icons/react'
import { useAuth } from '../lib/auth'
import { useInstallPrompt } from '../lib/installPrompt'
import { useNotificationSettings } from '../lib/notificationSettings'
import { devicePlatform, isInstalledApp, pushState, type DevicePlatform } from '../lib/push'
import { PushSwitch } from '../components/PushSwitch'

/**
 * The /app route: how to install this site as an app, and how to get
 * notifications from it — which are one question on an iPhone and two
 * everywhere else.
 *
 * It exists because neither is discoverable. Installing is an item in a menu
 * nobody opens (or, on iOS, an item in a share sheet, which is stranger
 * still), and on an iPhone or iPad a site cannot even ask for notifications
 * until it has been added to the Home Screen and opened from there. None of
 * that can be done *for* the reader — there is no API to install on iOS, and
 * a permission prompt has to come from a press — so the most the app can do is
 * say exactly what to press, for the device in their hand.
 *
 * So it opens on the reader's own kind of device and offers the other two
 * beside it — for the reader setting up somebody else's phone, and for the
 * one whose browser identifies itself as something it is not.
 *
 * Public, like About: the reader most likely to need it arrived on a share
 * link and has no account, and watching an open poll needs none.
 */
export function InstallGuide() {
  const { session } = useAuth()
  const [platform, setPlatform] = useState<DevicePlatform>(devicePlatform)

  return (
    <Stack maw={720} mx="auto" gap="md">
      <Title order={1}>Install the app</Title>

      <Text>
        STAR Voting works in any browser, but installed as an app it opens from your home screen
        like any other, and it can send you a notification when you&rsquo;re invited to a poll, when
        voting opens, and when the results are ready.
      </Text>

      <ThisDevice signedIn={!!session} userId={session?.user.id ?? null} />

      <SegmentedControl
        fullWidth
        value={platform}
        onChange={(value) => setPlatform(value as DevicePlatform)}
        data={[
          { value: 'ios', label: 'iPhone & iPad' },
          { value: 'android', label: 'Android' },
          { value: 'desktop', label: 'Computer' },
        ]}
      />

      {platform === 'ios' && <IosSteps />}
      {platform === 'android' && <AndroidSteps />}
      {platform === 'desktop' && <DesktopSteps />}

      <Title order={3} mt="md">
        What you&rsquo;ll be notified about
      </Title>
      <Stack gap="sm">
        <Card withBorder>
          <Stack gap={4}>
            <Text fw={700}>Polls you&rsquo;re invited to</Text>
            <Text size="sm">
              Sign in, then turn notifications on for each device you want them on — from{' '}
              <Anchor component={Link} to="/settings" inherit>
                Settings
              </Anchor>{' '}
              or from the top of this page. You&rsquo;ll hear when you&rsquo;re invited, when voting
              opens, and when the results are ready. Settings is also where you choose whether these
              come by email, as notifications, both, or neither.
            </Text>
          </Stack>
        </Card>
        <Card withBorder>
          <Stack gap={4}>
            <Text fw={700}>Polls you answer through a link</Text>
            <Text size="sm">
              No account needed. After you vote, or after you confirm the options on a poll that is
              still collecting them, press <em>Notify me</em>. That device hears when voting opens
              and when the results are ready, and nothing after that.
            </Text>
          </Stack>
        </Card>
      </Stack>
    </Stack>
  )
}

/**
 * Where the device in the reader's hand stands: installed or not, and
 * notifications on or not — with the button that turns them on, for a reader
 * who has come here to do exactly that.
 */
function ThisDevice({ signedIn, userId }: { signedIn: boolean; userId: string | null }) {
  const installed = isInstalledApp()
  const { settings, setSettings } = useNotificationSettings(userId)
  const state = pushState()

  return (
    <Card withBorder>
      <Stack gap="sm">
        <Title order={4}>This device</Title>
        <Group gap="xs" wrap="nowrap" align="flex-start">
          {installed && (
            <ThemeIcon size={20} radius="xl" color="green" variant="light">
              <CheckIcon size={12} weight="bold" aria-hidden />
            </ThemeIcon>
          )}
          <Text size="sm" c={installed ? undefined : 'dimmed'}>
            {installed
              ? 'You’re using the installed app.'
              : 'You’re using STAR Voting in a browser. The steps below install it.'}
          </Text>
        </Group>

        {signedIn && userId ? (
          <PushSwitch
            userId={userId}
            settings={settings}
            onChange={setSettings}
            guideLink={false}
          />
        ) : (
          <Text size="sm" c="dimmed">
            {state === 'needs-install'
              ? 'Notifications on an iPhone or iPad need the app installed first. '
              : state === 'denied'
                ? 'Notifications are blocked for this site in this browser; the steps below say how to allow them. '
                : ''}
            To hear about polls you&rsquo;re invited to,{' '}
            <Anchor component={Link} to="/" inherit>
              sign in
            </Anchor>{' '}
            and turn notifications on here. For a poll you opened from a link, press{' '}
            <em>Notify me</em> on the poll after you vote.
          </Text>
        )}
      </Stack>
    </Card>
  )
}

function Steps({ children }: { children: ReactNode }) {
  return (
    <List type="ordered" spacing="sm" withPadding>
      {children}
    </List>
  )
}

function Trouble({ children }: { children: ReactNode }) {
  return (
    <Card withBorder bg="var(--mantine-color-default-hover)">
      <Stack gap={4}>
        <Text fw={500} size="sm">
          Said no to notifications by mistake?
        </Text>
        <Text size="sm">{children}</Text>
      </Stack>
    </Card>
  )
}

/** Where to turn notifications on once installed, which is the same on every device. */
function TurnOn() {
  return (
    <List.Item>
      Turn notifications on — from{' '}
      <Anchor component={Link} to="/settings" inherit>
        Settings
      </Anchor>{' '}
      (the gear at the top) if you&rsquo;re signed in, or with <em>Notify me</em> on a poll you
      answered through a link — and choose <strong>Allow</strong> when your device asks.
    </List.Item>
  )
}

/**
 * iOS and iPadOS 16.4 or later. The one platform where installing is not
 * optional: Safari gives the push APIs only to a site opened from the Home
 * Screen.
 */
function IosSteps() {
  return (
    <Stack gap="md">
      <Text size="sm" c="dimmed">
        Needs iOS or iPadOS 16.4 or later. On iPhone and iPad, notifications only work once the app
        is installed.
      </Text>
      <Steps>
        <List.Item>Open this site in Safari.</List.Item>
        <List.Item>
          Tap the <strong>Share</strong> button — the square with an arrow pointing up. In newer
          versions of iOS it is inside the <strong>•••</strong> menu.
        </List.Item>
        <List.Item>
          Scroll down and tap <strong>Add to Home Screen</strong>. If you see{' '}
          <strong>Open as Web App</strong>, leave it switched on. Then tap <strong>Add</strong>.
        </List.Item>
        <List.Item>
          Open <strong>STAR Voting</strong> from your Home Screen. Notifications work in the app
          opened this way, not in a Safari tab.
        </List.Item>
        <List.Item>
          If you have an account, sign in again inside the app — it does not share Safari&rsquo;s
          sign-in. Choose <strong>Email a code</strong>: a sign-in link would open in Safari instead
          of the app.
        </List.Item>
        <TurnOn />
      </Steps>
      <Trouble>
        Open the <strong>Settings</strong> app, then <strong>Notifications</strong>, then{' '}
        <strong>STAR Voting</strong>, and switch on <strong>Allow Notifications</strong>.
      </Trouble>
    </Stack>
  )
}

function AndroidSteps() {
  const install = useInstallPrompt()
  return (
    <Stack gap="md">
      <Text size="sm" c="dimmed">
        Notifications work in Chrome without installing, but the app opens straight from your home
        screen.
      </Text>
      <Steps>
        <List.Item>Open this site in Chrome.</List.Item>
        <List.Item>
          <InstallNow install={install}>
            Open Chrome&rsquo;s <strong>⋮</strong> menu and tap <strong>Add to Home screen</strong>,
            then <strong>Install</strong>.
          </InstallNow>
        </List.Item>
        <List.Item>
          Open <strong>STAR Voting</strong> from your home screen or app drawer.
        </List.Item>
        <TurnOn />
      </Steps>
      <Trouble>
        Long-press the <strong>STAR Voting</strong> icon, tap <strong>App info</strong>, then{' '}
        <strong>Notifications</strong>, and turn them on. In Chrome without installing, open{' '}
        <strong>⋮</strong> → <strong>Settings</strong> → <strong>Site settings</strong> →{' '}
        <strong>Notifications</strong> and allow choicelab.app.
      </Trouble>
    </Stack>
  )
}

function DesktopSteps() {
  const install = useInstallPrompt()
  return (
    <Stack gap="md">
      <Text size="sm" c="dimmed">
        Notifications work in a browser tab without installing. On a computer they arrive while the
        browser is running.
      </Text>
      <Steps>
        <List.Item>
          <InstallNow install={install}>
            In <strong>Chrome</strong> or <strong>Edge</strong>, click the install icon at the right
            end of the address bar. In <strong>Safari</strong> on a Mac, choose{' '}
            <strong>File</strong> → <strong>Add to Dock</strong>. Firefox cannot install sites as
            apps, but notifications still work in a tab.
          </InstallNow>
        </List.Item>
        <TurnOn />
      </Steps>
      <Trouble>
        Click the icon at the left end of the address bar, find <strong>Notifications</strong>, and
        set it to <strong>Allow</strong>. On a Mac, also check <strong>System Settings</strong> →{' '}
        <strong>Notifications</strong> for your browser, or for STAR Voting if you installed it.
      </Trouble>
    </Stack>
  )
}

/**
 * The browser's own install dialog, where it has handed us one — Chrome and
 * Edge, not yet installed — and the menu steps where it has not. See
 * lib/installPrompt.ts.
 */
function InstallNow({ install, children }: { install: (() => void) | null; children: ReactNode }) {
  if (!install) return <>{children}</>
  return (
    <Stack gap="xs" align="flex-start">
      <Text inherit>This browser can install it in one step:</Text>
      <Button
        size="xs"
        leftSection={<DownloadSimpleIcon size={14} aria-hidden />}
        onClick={install}
      >
        Install STAR Voting
      </Button>
    </Stack>
  )
}
