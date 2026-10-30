import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Button,
  Card,
  Group,
  Loader,
  Modal,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
  Title,
  type MantineColor,
} from '@mantine/core'
import {
  ChartBarIcon,
  CodeIcon,
  DownloadSimpleIcon,
  EnvelopeSimpleIcon,
  HeartIcon,
  ListBulletsIcon,
  PlayCircleIcon,
  PlusIcon,
  QuestionIcon,
  ScalesIcon,
  SignInIcon,
  SignOutIcon,
  SparkleIcon,
  StarIcon,
  type Icon,
} from '@phosphor-icons/react'
import { useAuth } from '../lib/auth'
import { useMakePoll } from '../lib/makePoll'
import { isInstalledApp } from '../lib/push'
import { noteHomeVisited } from '../lib/homeVisit'
import { pollPath } from '../lib/pollId'
import { SAMPLE_POLL_ID, SAMPLE_RESULT_ID } from '../lib/samplePoll'
import { APP_TITLE, usePageTitle } from '../lib/pageTitle'
import { CODE_URL } from '../lib/sourceCode'
import { StarLoop } from '../components/StarLoop'
import classes from './Home.module.css'

/**
 * The front door, `/`, for everybody: what ChoiceLab is, a ballot being
 * scored, and a tile for every place the site goes. It is the one page that
 * links to the others — the header's logo comes back here, and every other
 * page carries *Back to homepage* (or, on a poll, *Your polls*, which is one
 * step nearer home) — so the gear menu holds settings and nothing else.
 *
 * The tiles are in pairs, two to a row on every screen, so each is an icon
 * and a word or two. Signing in and out lives here rather
 * than in the header: it is not something anybody does mid-poll.
 */
export function Home() {
  usePageTitle(APP_TITLE)
  const { session, anonymous, signOut } = useAuth()
  const account = session && !anonymous ? session : null
  const { start: makePoll, starting, error } = useMakePoll()
  // Signing out asks first: getting back in means a trip to the inbox.
  const [confirmingSignOut, setConfirmingSignOut] = useState(false)
  // A reader who has been here needs no banner pointing here; see HomeBanner.
  useEffect(noteHomeVisited, [])

  return (
    <Stack maw={720} mx="auto" gap="lg">
      <Stack gap={4} align="center" ta="center">
        <Title order={1} size="h2">
          Better group decisions
        </Title>
        <Text size="xl" c="dimmed">
          using STAR voting
        </Text>
      </Stack>

      <StarLoop />

      <Text ta="center">
        ChoiceLab is a free app to help with group decisions and advocate for STAR voting.
      </Text>

      <SimpleGrid cols={2} spacing="sm" verticalSpacing="sm">
        <Tile to="/intro" icon={PlayCircleIcon} color="violet" title="Watch intro" />
        <Tile
          to="/new"
          onClick={makePoll}
          loading={starting}
          icon={PlusIcon}
          color="green"
          title="New poll"
        />

        {account ? (
          <Tile
            onClick={() => setConfirmingSignOut(true)}
            icon={SignOutIcon}
            color="gray"
            title="Sign out"
          />
        ) : (
          <Tile
            to="/sign-in"
            state={anonymous ? { from: '/' } : undefined}
            icon={SignInIcon}
            color="gray"
            title="Sign in"
          />
        )}
        <Tile to="/polls" icon={ListBulletsIcon} color="blue" title="Your polls" />

        <Tile to="/star" icon={QuestionIcon} color="orange" title="What’s STAR?" />
        <Tile to="/why-star" icon={ScalesIcon} color="orange" title="Why STAR?" />

        <Tile to={pollPath(SAMPLE_POLL_ID)} icon={StarIcon} color="cyan" title="Example poll" />
        <Tile
          to={pollPath(SAMPLE_RESULT_ID)}
          icon={ChartBarIcon}
          color="cyan"
          title="Example result"
        />

        {/* Installing is the more useful offer; once installed, the slot
            goes to the code, which App features also links. */}
        {isInstalledApp() ? (
          <Tile href={CODE_URL} icon={CodeIcon} color="grape" title="App code" />
        ) : (
          <Tile to="/app" icon={DownloadSimpleIcon} color="grape" title="Install app" />
        )}
        <Tile to="/features" icon={SparkleIcon} color="grape" title="App features" />

        <Tile to="/contact" icon={EnvelopeSimpleIcon} color="indigo" title="Contact" />
        <Tile to="/donate" icon={HeartIcon} color="pink" title="Donate" />
      </SimpleGrid>
      {error && (
        <Text role="alert" size="sm" c="red" ta="center">
          {error}
        </Text>
      )}

      <Modal
        opened={confirmingSignOut}
        onClose={() => setConfirmingSignOut(false)}
        title={<Text fw={600}>Sign out?</Text>}
        centered
      >
        <Stack gap="md">
          <Text size="sm">
            {account?.user.email ? (
              <>
                You are signed in as <strong>{account.user.email}</strong>. To sign back in you will
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
            <Button
              onClick={() => {
                setConfirmingSignOut(false)
                void signOut()
              }}
              leftSection={<SignOutIcon size={16} aria-hidden />}
            >
              Sign out
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  )
}

/**
 * One tile: the whole card is the link (or the button), since there is
 * nothing else inside it to press. `onClick` takes over from `to` for a press
 * with work to do first; `href` leaves the site, in a tab of its own.
 */
function Tile({
  to,
  state,
  href,
  onClick,
  loading,
  icon: Glyph,
  color,
  title,
}: {
  to?: string
  state?: unknown
  href?: string
  onClick?: () => void
  loading?: boolean
  icon: Icon
  color: MantineColor
  title: string
}) {
  const body = (
    <div className={classes.body}>
      <ThemeIcon size={36} radius="md" variant="light" color={color} className={classes.icon}>
        {loading ? <Loader size={16} color={color} /> : <Glyph size={20} aria-hidden />}
      </ThemeIcon>
      <Text fw={600} size="sm" lh={1.3} className={classes.title}>
        {title}
      </Text>
    </div>
  )
  const shared = { withBorder: true, radius: 'md', p: 'sm', className: classes.tile } as const

  if (onClick)
    return (
      <Card {...shared} component="button" type="button" onClick={onClick} aria-busy={loading}>
        {body}
      </Card>
    )
  if (href)
    return (
      <Card {...shared} component="a" href={href} target="_blank" rel="noopener noreferrer">
        {body}
      </Card>
    )
  return (
    <Card {...shared} component={Link} to={to!} state={state}>
      {body}
    </Card>
  )
}
