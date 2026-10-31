import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Anchor } from '@mantine/core'
import {
  BellIcon,
  CalendarDotsIcon,
  CodeIcon,
  DeviceMobileIcon,
  EnvelopeSimpleIcon,
  EyeSlashIcon,
  GiftIcon,
  LightbulbIcon,
  LightningIcon,
  LinkIcon,
  ListNumbersIcon,
  ScalesIcon,
  ShieldCheckIcon,
  SignInIcon,
  type Icon,
} from '@phosphor-icons/react'
import { CODE_URL } from '../lib/sourceCode'

/**
 * What the site does, said once: the features page draws these as tiles and
 * the intro turns through them in its carousel. Each line has to read on its
 * own in the carousel's small card, so keep it to a sentence or two, and keep
 * it true — a newcomer may be weighing the site on it.
 */
export interface SiteFeature {
  icon: Icon
  title: string
  text: ReactNode
}

export const SITE_FEATURES: SiteFeature[] = [
  {
    icon: LinkIcon,
    title: 'Low-friction open polls',
    text: <>Share a link and anyone can vote without needing to sign in.</>,
  },
  {
    icon: EnvelopeSimpleIcon,
    title: 'Email-authenticated polls',
    text: <>Invite voters by email to ensure your voters can only vote once.</>,
  },
  {
    icon: ListNumbersIcon,
    title: 'Multi-question polls',
    text: <>Make several decisions at once using a single link.</>,
  },
  {
    icon: LightbulbIcon,
    title: 'Option solicitation',
    text: <>Let voters suggest options prior to voting.</>,
  },
  {
    icon: CalendarDotsIcon,
    title: 'Time selection polls',
    text: <>Find a time to meet using the same STAR voting system.</>,
  },
  {
    icon: EyeSlashIcon,
    title: 'Configurable privacy',
    text: <>Choose whether voters&rsquo; names and ballots are shown or hidden.</>,
  },
  {
    icon: SignInIcon,
    title: 'Password-free sign-in',
    text: <>Sign in with an emailed link to manage your polls across devices.</>,
  },
  {
    icon: LightningIcon,
    title: 'Real-time results',
    text: <>Watch your polls update without needing to refresh the page.</>,
  },
  {
    icon: BellIcon,
    title: 'Notifications',
    text: <>See when your polls have updates via email or push notifications.</>,
  },
  {
    icon: DeviceMobileIcon,
    title: 'Support for any device',
    text: (
      <>
        Works on any device and can be{' '}
        <Anchor component={Link} to="/app" inherit>
          installed
        </Anchor>{' '}
        as an app.
      </>
    ),
  },
  {
    icon: ScalesIcon,
    title: 'Fair results',
    text: <>Get better group decisions due to the advantages of STAR.</>,
  },
  {
    icon: ShieldCheckIcon,
    title: 'Trustworthy design',
    text: <>Polls can't be tampered with unfairly, even by their creators.</>,
  },
  {
    icon: CodeIcon,
    title: 'Open-source code',
    text: (
      <>
        Every line of code is{' '}
        <Anchor href={CODE_URL} target="_blank" rel="noopener noreferrer" inherit>
          published
        </Anchor>
        , so anyone can audit it.
      </>
    ),
  },
  {
    icon: GiftIcon,
    title: 'Free',
    text: (
      <>
        No ads, fees, or data collection. All{' '}
        <Anchor component={Link} to="/donate" inherit>
          donations
        </Anchor>{' '}
        go to Khan Academy.
      </>
    ),
  },
]
