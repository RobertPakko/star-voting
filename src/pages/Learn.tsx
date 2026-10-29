import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Anchor, List, Paper, Stack, Text, Title } from '@mantine/core'
import { usePageTitle } from '../lib/pageTitle'
import { CODE_URL } from '../lib/sourceCode'

/**
 * The three pages that explain: what STAR voting is (`/star`), why use it
 * (`/why-star`), and what this site does with it (`/features`). Each is a
 * home-page tile of its own, so each is one short page rather than a tab of a
 * longer one. Public, because the people who most need them are the ones who
 * arrived from a share link and have never heard of the method.
 *
 * Each page numbers its own footnotes from 1; see `Footnotes`.
 */
export function WhatIsStar() {
  usePageTitle('What is STAR?')
  return (
    <Stack maw={720} mx="auto" gap="sm">
      <Title order={1} mb="xs">
        What is STAR?
      </Title>
      <Text>
        <Ext href="https://en.wikipedia.org/wiki/STAR_voting">STAR voting</Ext> is an acronym that
        stands for &ldquo;Score Then Automatic Runoff&rdquo;. It combines{' '}
        <Ext href="https://en.wikipedia.org/wiki/Score_voting">score voting</Ext> with{' '}
        <Ext href="https://en.wikipedia.org/wiki/Instant-runoff_voting">ranked choice voting</Ext>{' '}
        algorithms. The following procedure is used to resolve an election:
      </Text>
      <Cards items={STEPS} />
      <Footnotes notes={PROCEDURE_NOTES} />
    </Stack>
  )
}

export function WhyStar() {
  usePageTitle('Why use STAR?')
  return (
    <Stack maw={720} mx="auto" gap="sm">
      <Title order={1} mb="xs">
        Why use STAR?
      </Title>
      <Text>
        STAR voting has several useful properties that no other voting system offers in full. STAR
        voting is:
      </Text>
      {/* Each property answers the shortcoming of the system above it, so
          these stay in order and read as one argument rather than a
          shuffleable feature list. */}
      <Cards items={PROPERTIES} />
      <Footnotes notes={BENEFIT_NOTES} />
    </Stack>
  )
}

export function Features() {
  usePageTitle('App features')
  return (
    <Stack maw={720} mx="auto" gap="sm">
      <Title order={1} mb="xs">
        App features
      </Title>
      <Text>
        This site is designed to be a simple, easy-to-use platform for creating and responding to
        polls using STAR voting. It includes features such as:
      </Text>
      <Cards items={FEATURES} />
    </Stack>
  )
}

/**
 * The two tie-break rules, which are the two places the procedure above says
 * "and if that is level, then what?".
 */
const PROCEDURE_NOTES: ReactNode[] = [
  <>
    A tie between two options in the scoring round is broken in favor of the one preferred by more
    voters: the one scored higher than the other on more ballots. If that is level too, or if three
    or more options are tied, the tie is broken in favor of the options given five stars on the most
    ballots. If they remain tied after that, a finalist is chosen randomly between them.
  </>,
  <>
    A tie in the runoff is broken in favor of the option with the higher total score. If both
    finalists also have the same score, it goes to the one given five stars on more ballots. If they
    are level on all three, the election has no winner.
  </>,
]

/** The three caveats the case for STAR makes on its own behalf. */
const BENEFIT_NOTES: ReactNode[] = [
  <>
    <Ext href="https://en.wikipedia.org/wiki/Gibbard%27s_theorem">Gibbard&rsquo;s theorem</Ext>{' '}
    demonstrates that no deterministic, non-dictatorial voting method can be entirely immune from
    tactical voting.
  </>,
  <>
    STAR voting is not perfectly accurate, but all perfectly accurate voting systems either
    can&rsquo;t be computed reliably, can&rsquo;t be understood reliably, or can&rsquo;t be audited
    reliably.
  </>,
  <>
    If you want to audit and verify things yourself, the complete implementation of this site is
    available at <Ext href={CODE_URL}>github.com/RobertPakko/star-voting</Ext>.
  </>,
]

/**
 * The notes belonging to one page, under the cards they annotate. Each page
 * numbers its own from 1; nothing is cross-referenced between them.
 */
function Footnotes({ notes }: { notes: ReactNode[] }) {
  return (
    <Stack gap="sm" mt="md">
      <Title order={2} size="h5">
        Footnotes
      </Title>
      <List type="ordered" spacing="xs" size="sm" withPadding c="dimmed">
        {notes.map((note, i) => (
          // Static prose in source order: there is nothing else to key on,
          // and no reordering for a better key to survive.
          <List.Item key={i}>{note}</List.Item>
        ))}
      </List>
    </Stack>
  )
}

/** One bordered entry on a page: a name and the paragraph under it. */
interface Entry {
  name: string
  body: ReactNode
}

const STEPS: Entry[] = [
  {
    name: '1: Options defined',
    body: <>Decide what options are available to vote on.</>,
  },
  {
    name: '2: Votes cast',
    body: (
      <>
        Each voter gives each option a number of stars from 0 up to 5, with 0 being the worst score
        and 5 being the best score.
      </>
    ),
  },
  {
    name: '3: Scores tallied',
    body: (
      <>
        Once all votes are cast, a score for each option is calculated reflecting the total number
        of stars that it received.
      </>
    ),
  },
  {
    name: '4: Finalists determined',
    body: (
      <>
        The two options with the highest scores are selected as finalists
        <Footnote n={1} />.
      </>
    ),
  },
  {
    name: '5: Winner resolved',
    body: (
      <>
        Among the two finalists, the option that is preferred by more voters is selected as the
        winner
        <Footnote n={2} />.
      </>
    ),
  },
]

const FEATURES: Entry[] = [
  {
    name: 'Optional authentication',
    body: (
      <>
        Use the seamless sign-in system to authenticate your voters, or skip it to allow anyone with
        the link to vote.
      </>
    ),
  },
  {
    name: 'Clear procedures',
    body: (
      <>
        Voters won't be left wondering why one option was picked over another. Every step and every
        tie-breaker is explained in detail so voters can understand the result.
      </>
    ),
  },
  {
    name: 'Real-time results',
    body: <>No need to ever refresh; all updates are streamed to your browser in real-time.</>,
  },
  {
    name: 'Flexible configuration',
    body: (
      <>
        Build polls with multiple questions, solicit options from voters, find a time with
        schedule-based polls, choose whether voters / ballots are visible, and more.
      </>
    ),
  },
  {
    name: 'Convenient notifications',
    body: (
      <>
        The site can let you know when results are ready, when a poll that's soliciting options has
        opened for voting, or when you've been invited to a new poll; either via email or with push
        notifications.
      </>
    ),
  },
  {
    name: 'Trustworthy design',
    body: (
      <>
        Voters can't update their votes after the poll closes, creators can't change options after
        votes have been cast, and results are inaccessible until the poll is over. The system is
        designed to ensure that polls can't be tampered with unfairly, even by their creator.
      </>
    ),
  },
  {
    name: 'Open-source code',
    body: (
      <>
        This site is an <Ext href={CODE_URL}>open-source</Ext> project. It is free to use and it
        does not contain ads, trackers, or any other monetization scheme.
      </>
    ),
  },
  {
    name: 'Installable app',
    body: (
      <>
        Add ChoiceLab to your phone&rsquo;s home screen or your computer&rsquo;s app list, and it
        opens in a window of its own.{' '}
        <Anchor component={Link} to="/app" inherit>
          See how
        </Anchor>
        .
      </>
    ),
  },
]

const PROPERTIES: Entry[] = [
  {
    name: 'Non-polarizing',
    body: (
      <>
        <Ext href="https://en.wikipedia.org/wiki/First-past-the-post_voting">Plurality voting</Ext>{' '}
        incentivizes two party systems. Multiple similar options can split the vote and lead to an
        election result that is out of alignment with the will of the electorate. STAR voting is
        non-polarizing because many options can be rated highly.
      </>
    ),
  },
  {
    name: 'Expressive',
    body: (
      <>
        <Ext href="https://en.wikipedia.org/wiki/Approval_voting">Approval voting</Ext> solves the
        above problem, but it doesn&rsquo;t allow voters to express the magnitude of their
        preference. STAR voting is expressive because voters can express different levels of
        preference for each option.
      </>
    ),
  },
  {
    name: 'Strategy-resistant',
    body: (
      <>
        <Ext href="https://en.wikipedia.org/wiki/Score_voting">Score voting</Ext> solves the above
        problems, but it incentivizes dishonesty. The optimal strategy is often to give the highest
        score to your preferred candidate and no points to their rivals, potentially degrading into
        plurality voting. STAR voting is strategy-resistant because the optimal strategy is almost
        <Footnote n={1} /> always to vote honestly.
      </>
    ),
  },
  {
    name: 'Accurate',
    body: (
      <>
        <Ext href="https://en.wikipedia.org/wiki/Instant-runoff_voting">Ranked choice voting</Ext>{' '}
        solves the above problems, but it&rsquo;s simply inaccurate in some cases. It's vulnerable
        to 'center squeeze' and 'spoiler' effects in common scenarios. STAR voting is accurate
        because it addresses most
        <Footnote n={2} /> situations where ranked choice voting becomes inaccurate.
      </>
    ),
  },
  {
    name: 'Computable',
    body: (
      <>
        <Ext href="https://en.wikipedia.org/wiki/Kemeny_method">The Kemeny method</Ext> solves the
        above problems, but with many votes it quickly becomes infeasibly computationally complex.
        Producing an election result using the Kemeny method is an NP-hard problem. STAR voting is
        computable because it can be trivially computed even with a large number of votes and
        options.
      </>
    ),
  },
  {
    name: 'Comprehensible',
    body: (
      <>
        <Ext href="https://en.wikipedia.org/wiki/Schulze_method">The Schulze method</Ext> solves the
        above problems but frankly it&rsquo;s completely incomprehensible without a deep knowledge
        of directed graph algorithms. STAR voting is comprehensible because anyone can understand
        its procedure.
      </>
    ),
  },
  {
    name: 'Transparent',
    body: (
      <>
        <Ext href="https://en.wikipedia.org/wiki/Random_ballot">Random ballot</Ext> solves the above
        problems but it&rsquo;s completely unauditable since true randomness is unverifiable. STAR
        voting is transparent because its election result can be audited and verified
        <Footnote n={3} />.
      </>
    ),
  },
]

/** The bordered list every page here is made of; three lists, one shape. */
function Cards({ items }: { items: Entry[] }) {
  return (
    <Stack gap="sm">
      {items.map((item) => (
        <Paper key={item.name} withBorder p="md" radius="md">
          <Stack gap={4}>
            <Text fw={700}>{item.name}</Text>
            <Text size="sm">{item.body}</Text>
          </Stack>
        </Paper>
      ))}
    </Stack>
  )
}

function Ext({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Anchor href={href} target="_blank" rel="noopener noreferrer" inherit>
      {children}
    </Anchor>
  )
}

/**
 * A marker only, not a jump link: the app is served under HashRouter, so an
 * href of "#fn-1" would be read as a route rather than an in-page anchor.
 */
function Footnote({ n }: { n: number }) {
  return (
    <Text component="sup" size="xs" c="dimmed" fw={700} span>
      {n}
    </Text>
  )
}
