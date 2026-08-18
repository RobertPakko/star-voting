import type { ReactNode } from 'react'
import { Anchor, Container, Divider, List, Paper, Stack, Text, Title } from '@mantine/core'
import { useAuth } from '../lib/auth'
import { PublicHeader } from '../components/PublicHeader'

/**
 * The /about route: what STAR voting is and why this site uses it. Public,
 * because the people who most need it are the ones who arrived from a share
 * link and have never heard of the method.
 */
export function About() {
  const { session } = useAuth()

  return (
    <Container size="sm" py={session ? 0 : 'xl'}>
      <Stack gap="xl">
        {/* Signed-in readers already have the app shell's header above them;
            signed-out ones are on a bare page and need the theme control and
            a way into the app. No About link — they are already on it. */}
        {!session && <PublicHeader showAbout={false} />}

        <Title order={1}>About</Title>

        <Stack gap="sm">
          <Title order={2} size="h3">
            What is STAR voting?
          </Title>
          <Text>
            <Ext href="https://en.wikipedia.org/wiki/STAR_voting">STAR voting</Ext> is a mechanism
            for conducting elections. It can be used for decisions as serious as choosing a national
            leader to as trivial as selecting a film for your next movie night. This website allows
            you to create and respond to polls using STAR voting.
          </Text>
        </Stack>

        <Stack gap="sm">
          <Title order={2} size="h3">
            How does STAR voting work?
          </Title>
          <Text>
            STAR voting is an acronym that stands for &ldquo;Score Then Automatic Runoff&rdquo;. It
            is a combination of{' '}
            <Ext href="https://en.wikipedia.org/wiki/Score_voting">score voting</Ext> and{' '}
            <Ext href="https://en.wikipedia.org/wiki/Instant-runoff_voting">ranked choice voting</Ext>{' '}
            algorithms. The following procedure is used to resolve an election:
          </Text>
          <List type="ordered" spacing="xs" withPadding>
            <List.Item>A ballot with an arbitrary number of options is created.</List.Item>
            <List.Item>
              Each voter gives each option a number of stars from 0 up to 5, with 0 being the worst
              score and 5 being the best score.
            </List.Item>
            <List.Item>
              Once all votes are cast, for each option, a score is calculated reflecting the total
              number of stars that the option received.
            </List.Item>
            <List.Item>
              The two options with the highest scores are selected as finalists
              <Footnote n={1} />.
            </List.Item>
            <List.Item>
              Among the two finalists, the option that was given a higher score on a greater number
              of ballots is selected as the winner
              <Footnote n={2} />.
            </List.Item>
          </List>
        </Stack>

        <Stack gap="sm">
          <Title order={2} size="h3">
            Why would I want to use STAR voting?
          </Title>
          <Text>
            STAR voting has a combination of cohesive properties that no other voting system offers
            in its entirety. STAR voting is:
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
          <Divider />
          <Title order={3} size="h5">
            Footnotes
          </Title>
          <List type="ordered" spacing="xs" size="sm" withPadding c="dimmed">
            <List.Item>
              A tie in the scoring round is broken in favor of the option that is preferred by more
              voters in head-to-head comparisons against the other tied options. If the options are
              still tied, it goes to the one given five stars on the most ballots. If they remain
              tied after both rules, a finalist is chosen randomly between them.
            </List.Item>
            <List.Item>
              A tie in the runoff is broken in favor of the option with the higher total score. If
              both finalists also have the same score, it goes to the one given five stars on more
              ballots — the same rule that settles a tie in the scoring round. If they are level on
              all three, the election has no winner: the tie is genuine, and this site reports it as
              such rather than inventing a result.
            </List.Item>
            <List.Item>
              <Ext href="https://en.wikipedia.org/wiki/Gibbard%27s_theorem">Gibbard&rsquo;s theorem</Ext>{' '}
              demonstrates that no deterministic, non-dictatorial voting method can be entirely
              immune from tactical voting.
            </List.Item>
            <List.Item>
              STAR voting is not perfectly accurate, but all perfectly accurate voting systems
              either can&rsquo;t be computed reliably, can&rsquo;t be understood reliably, or
              can&rsquo;t be audited reliably.
            </List.Item>
            <List.Item>
              This site is open source, which is a form of transparency in its own right: an
              election result is only as auditable as the code that produced it. The complete
              implementation — including every tie-break rule described above — can be read at{' '}
              <Ext href="https://github.com/RobertPakko/star-voting">
                github.com/RobertPakko/star-voting
              </Ext>
              .
            </List.Item>
          </List>
        </Stack>
      </Stack>
    </Container>
  )
}

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
        preference. STAR voting is expressive because voters have various levels of preference that
        can be assigned to options.
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
        solves the above problems, but it&rsquo;s simply inaccurate in many cases (enumerated on
        Wikipedia). STAR voting is accurate because it addresses most
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
