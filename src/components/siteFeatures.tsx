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
    text: <>Share a link and anyone holding it can vote, with no account needed.</>,
  },
  {
    icon: EnvelopeSimpleIcon,
    title: 'Email-authenticated polls',
    text: (
      <>Invite voters by email when it matters who votes: each one signs in and gets one ballot.</>
    ),
  },
  {
    icon: ListNumbersIcon,
    title: 'Multi-question polls',
    text: (
      <>Ask several questions in one poll, with one invitation and one reveal of the results.</>
    ),
  },
  {
    icon: LightbulbIcon,
    title: 'Option solicitation',
    text: <>Let voters suggest the options, then open the finished list for voting.</>,
  },
  {
    icon: CalendarDotsIcon,
    title: 'Time selection polls',
    text: <>Find a time to meet: everybody paints a calendar with how well each hour suits them.</>,
  },
  {
    icon: EyeSlashIcon,
    title: 'Configurable privacy',
    text: (
      <>
        Choose whether voters&rsquo; names and ballots are shown or hidden. Either way, this site
        will never publish or sell your data.
      </>
    ),
  },
  {
    icon: SignInIcon,
    title: 'Password-free sign-in',
    text: <>Sign in with a link or code sent to your email, and keep all your polls in one list.</>,
  },
  {
    icon: LightningIcon,
    title: 'Real-time results',
    text: <>Votes and results arrive as they happen, with no need to refresh the page.</>,
  },
  {
    icon: BellIcon,
    title: 'Notifications',
    text: (
      <>
        Hear when you&rsquo;re invited, when voting opens, and when results are ready, by email or
        push notification.
      </>
    ),
  },
  {
    icon: DeviceMobileIcon,
    title: 'Support for any device',
    text: (
      <>
        Works on phones, tablets and computers, and installs as an app on your home screen.{' '}
        <Anchor component={Link} to="/app" inherit>
          See how
        </Anchor>
        .
      </>
    ),
  },
  {
    icon: ShieldCheckIcon,
    title: 'Trustworthy design',
    text: (
      <>
        Results stay sealed until the poll is over, every tie-break is explained, and any late
        change to a poll is flagged on its results.
      </>
    ),
  },
  {
    icon: CodeIcon,
    title: 'Open-source code',
    text: (
      <>
        Every line of this site is{' '}
        <Anchor href={CODE_URL} target="_blank" rel="noopener noreferrer" inherit>
          published
        </Anchor>
        , so anyone can check how it works.
      </>
    ),
  },
  {
    icon: GiftIcon,
    title: 'Free',
    text: (
      <>
        No ads, no trackers and no fees.{' '}
        <Anchor component={Link} to="/donate" inherit>
          All donations
        </Anchor>{' '}
        go to Khan Academy.
      </>
    ),
  },
]
