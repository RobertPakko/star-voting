import type { ReactNode } from 'react'
import { Anchor, List, Paper, Stack, Text, Title } from '@mantine/core'

/**
 * The /about route: what STAR voting is and why this site uses it. Public,
 * because the people who most need it are the ones who arrived from a share
 * link and have never heard of the method.
 */
export function About() {
  return (
    <Stack gap="xl" maw={720} mx="auto">
      <Title order={1}>About</Title>

      <Stack gap="sm">
        <Title order={2} size="h3">
          What is STAR voting?
        </Title>
        <Text>
          <Ext href="https://en.wikipedia.org/wiki/STAR_voting">STAR voting</Ext> is a mechanism for
          conducting elections and this website allows you to create and respond to polls using STAR voting.
          Check out the sample poll and sample results to see it in action, or read on to learn more.
        </Text>
        <List>
          <List.Item>Sample poll</List.Item>
          <List.Item>Sample results</List.Item>
        </List>

      </Stack>

      <Stack gap="sm">
        <Title order={2} size="h3">
          STAR Procedure
        </Title>
        <Text>
          STAR voting is an acronym that stands for &ldquo;Score Then Automatic Runoff&rdquo;. It
          combines <Ext href="https://en.wikipedia.org/wiki/Score_voting">score voting</Ext> with{' '}
          <Ext href="https://en.wikipedia.org/wiki/Instant-runoff_voting">ranked choice voting</Ext>{' '}
          algorithms. The following procedure is used to resolve an election:
        </Text>
        <Stack gap="sm">
          {STEPS.map((step) => (
            <Paper key={step.name} withBorder p="md" radius="md">
              <Stack gap={4}>
                <Text fw={700}>{step.name}</Text>
                <Text size="sm">{step.body}</Text>
              </Stack>
            </Paper>
          ))}
        </Stack>
      </Stack>

      <Stack gap="sm">
        <Title order={2} size="h3">
          Site features
        </Title>
        <Text>
          This site is designed to be a simple, easy-to-use platform for creating and responding to polls using STAR voting. It includes features such as:
        </Text>
        <Stack gap="sm">
          {FEATURES.map((feature) => (
            <Paper key={feature.name} withBorder p="md" radius="md">
              <Stack gap={4}>
                <Text fw={700}>{feature.name}</Text>
                <Text size="sm">{feature.body}</Text>
              </Stack>
            </Paper>
          ))}
        </Stack>
      </Stack>

      <Stack gap="sm">
        <Title order={2} size="h3">
          STAR Benefits
        </Title>
        <Text>
          STAR voting has several useful properties that no other voting system offers in full. STAR
          voting is:
        </Text>
        {/* Each property answers the shortcoming of the system above it, so
            these stay in order and read as one argument rather than a
            shuffleable feature list. */}
        <Stack gap="sm">
          {PROPERTIES.map((property) => (
            <Paper key={property.name} withBorder p="md" radius="md">
              <Stack gap={4}>
                <Text fw={700}>{property.name}</Text>
                <Text size="sm">{property.body}</Text>
              </Stack>
            </Paper>
          ))}
        </Stack>
      </Stack>

      <Stack gap="sm">
        <Title order={3} size="h5">
          Footnotes
        </Title>
        <List type="ordered" spacing="xs" size="sm" withPadding c="dimmed">
          <List.Item>
            A tie in the scoring round is broken in favor of the option that is preferred by the
            most voters among the tied options. That's decided by comparing the tied options one
            pair at a time. For each pair, we check which option is preferred by more voters. An
            option is 'preferred by more voters' when it receives a higher score than the other
            option on a greater number of ballots than the other option. Whichever option is
            preferred in the most of these one-on-one comparisons wins the tie. If the options are
            still tied, the tie is broken in favor of the option given five stars on the most
            ballots. If they remain tied after both rules, a finalist is chosen randomly between
            them.
          </List.Item>
          <List.Item>
            A tie in the runoff is broken in favor of the option with the higher total score. If
            both finalists also have the same score, it goes to the one given five stars on more
            ballots. If they are level on all three, the election has no winner.
          </List.Item>
          <List.Item>
            <Ext href="https://en.wikipedia.org/wiki/Gibbard%27s_theorem">
              Gibbard&rsquo;s theorem
            </Ext>{' '}
            demonstrates that no deterministic, non-dictatorial voting method can be entirely immune
            from tactical voting.
          </List.Item>
          <List.Item>
            STAR voting is not perfectly accurate, but all perfectly accurate voting systems either
            can&rsquo;t be computed reliably, can&rsquo;t be understood reliably, or can&rsquo;t be
            audited reliably.
          </List.Item>
          <List.Item>
            If you want to audit and verify things yourself, the complete implementation of this
            site is available at{' '}
            <Ext href="https://github.com/RobertPakko/star-voting">
              github.com/RobertPakko/star-voting
            </Ext>
            .
          </List.Item>
        </List>
      </Stack>
    </Stack>
  )
}

const STEPS: { name: string; body: ReactNode }[] = [
  {
    name: '1: Options are defined',
    body: (
      <>
        Define what options are available to vote on.
      </>
    )
  },
  {
    name: '2: Options are rated',
    body: (
      <>
        Each voter gives each option a number of stars from 0 up to 5, with 0 being the worst score and 5 being the best score.
      </>
    )
  },
  {
    name: '3: Scores are tallied',
    body: (
      <>
        Once all votes are cast, a score for reach option is calculated reflecting the total number of stars that it received.
      </>
    )
  },
  {
    name: '4: Finalists are selected',
    body: (
      <>
        The two options with the highest scores are selected as finalists
        <Footnote n={1} />.
      </>
    )
  },
  {
    name: '5: A winner is selected',
    body: (
      <>
        Among the two finalists, the option that is preferred by more voters is selected as the winner
        <Footnote n={2} />.
      </>
    )
  }
];

const FEATURES: { name: string; body: ReactNode }[] = [
  {
    name: 'Optional authentication',
    body: (
      <>
        Use the seamless sign-in system to authenticate your voters, or skip it to allow anyone with the link to vote.
      </>
    )
  },
  {
    name: 'Choose your own balance of privacy and transparency',
    body: (
      <>Keep either voters or votes hidden for privacy or published for transparency.</>
    )
  },
  {
    name: 'Clearly explained procedure',
    body: (
      <>
        Voters won't be left wondering why one option was picked over another. Every step and every tie-breaker is explained in detail so voters can understand the result.
      </>
    )
  },
  {
    name: 'See the full ranking of results',
    body: (
      <>
        If any options become unavailable after the poll closes, you can see their full ranking to pick a new winner without re-running the poll.
      </>
    )
  },
  {
    name: 'Trustworthy design',
    body: (
      <>
        Voters can't update their votes after the poll closes, creators can't change options after votes have been cast, and new votes can't be added after the poll closes. The system is designed to ensure that polls can't be tampered with unfairly, even by their creator.
      </>
    )
  },
  {
    name: 'Robust poll management',
    body: (
      <>
        Multi-question support, share with a QR code, add descriptions to options, solicit options from voters, and more. This site is designed to be a full-featured poll management system.
      </>
    )
  },
  {
    name: 'Real-time results',
    body: (
      <>
        No need to ever refresh; all updates are streamed to your browser in real-time.
      </>
    ),
  },
  {
    name: 'Free and open-source',
    body: (
      <>
        This site is free to use and not monetized. It does not contain ads, trackers, or any other monetization
        scheme. It is a free and open-source project.
      </>
    ),
  }
];

const PROPERTIES: { name: string; body: ReactNode }[] = [
  {
    name: 'Polarization-resistant',
    body: (
      <>
        <Ext href="https://en.wikipedia.org/wiki/First-past-the-post_voting">Plurality voting</Ext>{' '}
        incentivizes two party systems. Multiple similar options can split the vote and lead to an
        election result that is out of alignment with the will of the electorate. STAR voting
        resists polarization since many options can be rated highly.
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
        <Footnote n={3} /> always to vote honestly.
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
        <Footnote n={4} /> situations where ranked choice voting becomes inaccurate.
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
        <Footnote n={5} />.
      </>
    ),
  },
]

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
