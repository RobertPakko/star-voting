import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  Anchor,
  Button,
  Card,
  Group,
  List,
  Paper,
  SimpleGrid,
  Stack,
  Tabs,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core'
import { SAMPLE_POLL_TOKEN, SAMPLE_RESULT_TOKEN } from '../lib/samplePoll'

/**
 * The /about route: what STAR voting is and why this site uses it. Public,
 * because the people who most need it are the ones who arrived from a share
 * link and have never heard of the method.
 *
 * Three of its four parts -- the procedure, what this site does with it, and
 * the case for the method -- are behind tabs. They are reference rather than
 * argument: nobody reads all three in order, and stacked one after another
 * they made a page long enough that the sample links at the top of it, which
 * are the fastest way to understand any of this, scrolled away from the only
 * paragraph that says why you would want them.
 *
 * What stays outside the tabs is what every reader needs on arrival: the
 * sentence that says what this is, and the two samples. Each tab carries its
 * own footnotes, numbered from 1; see `Footnotes`.
 */
export function About() {
  const [tab, setTab] = useState<string | null>('procedure')

  return (
    <Stack gap="md" maw={720} mx="auto">
      <Title order={1}>About</Title>

      <Text>
        <Ext href="https://en.wikipedia.org/wiki/STAR_voting">STAR voting</Ext> is a mechanism for
        conducting elections and this website allows you to create and respond to polls using STAR
        voting. Check out the samples to see it in action, read on to learn more about STAR, or sign in to try it yourself.
      </Text>
      <Samples />

      <Tabs value={tab} onChange={setTab} keepMounted={false}>
        <Tabs.List grow>
          <Tabs.Tab value="procedure">STAR procedure</Tabs.Tab>
          <Tabs.Tab value="features">Site features</Tabs.Tab>
          <Tabs.Tab value="benefits">STAR benefits</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="procedure" pt="lg">
          <Stack gap="sm">
            <Text>
              STAR voting is an acronym that stands for &ldquo;Score Then Automatic Runoff&rdquo;.
              It combines <Ext href="https://en.wikipedia.org/wiki/Score_voting">score voting</Ext>{' '}
              with{' '}
              <Ext href="https://en.wikipedia.org/wiki/Instant-runoff_voting">
                ranked choice voting
              </Ext>{' '}
              algorithms. The following procedure is used to resolve an election:
            </Text>
            <Cards items={STEPS} />
            <Footnotes notes={PROCEDURE_NOTES} />
          </Stack>
        </Tabs.Panel>

        <Tabs.Panel value="features" pt="lg">
          <Stack gap="sm">
            <Text>
              This site is designed to be a simple, easy-to-use platform for creating and responding
              to polls using STAR voting. It includes features such as:
            </Text>
            <Cards items={FEATURES} />
          </Stack>
        </Tabs.Panel>

        <Tabs.Panel value="benefits" pt="lg">
          <Stack gap="sm">
            <Text>
              STAR voting has several useful properties that no other voting system offers in full.
              STAR voting is:
            </Text>
            {/* Each property answers the shortcoming of the system above it, so
                these stay in order and read as one argument rather than a
                shuffleable feature list. */}
            <Cards items={PROPERTIES} />
            <Footnotes notes={BENEFIT_NOTES} />
          </Stack>
        </Tabs.Panel>
      </Tabs>
    </Stack>
  )
}

/**
 * The two tie-break rules, which are the two places the procedure above says
 * "and if that is level, then what?".
 */
const PROCEDURE_NOTES: ReactNode[] = [
  <>
    A tie in the scoring round is broken in favor of the option that is preferred by the most voters
    among the tied options. That's decided by comparing the tied options one pair at a time. For
    each pair, we check which option is preferred by more voters. An option is 'preferred by more
    voters' when it receives a higher score than the other option on a greater number of ballots
    than the other option. Whichever option is preferred in the most of these one-on-one comparisons
    wins the tie. If the options are still tied, the tie is broken in favor of the option given five
    stars on the most ballots. If they remain tied after both rules, a finalist is chosen randomly
    between them.
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
    available at{' '}
    <Ext href="https://github.com/RobertPakko/star-voting">github.com/RobertPakko/star-voting</Ext>.
  </>,
]

/**
 * The notes belonging to one tab, under the cards they annotate.
 *
 * Each tab numbers its own from 1, which is the reason there are two lists
 * rather than one: a single list shared by two tabs has to be readable from
 * either, so it sat under both of them and made every reader of the procedure
 * scroll past three notes about a case they had not read yet. Nothing here is
 * cross-referenced between tabs, so nothing is lost by splitting it -- and the
 * markers now sit a screen away from what they mark instead of a page.
 */
function Footnotes({ notes }: { notes: ReactNode[] }) {
  return (
    <Stack gap="sm" mt="md">
      <Title order={3} size="h5">
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

/** One bordered entry in a tab: a name and the paragraph under it. */
interface Entry {
  name: string
  body: ReactNode
}

const STEPS: Entry[] = [
  {
    name: '1: Options are defined',
    body: <>Define what options are available to vote on.</>,
  },
  {
    name: '2: Options are rated',
    body: (
      <>
        Each voter gives each option a number of stars from 0 up to 5, with 0 being the worst score
        and 5 being the best score.
      </>
    ),
  },
  {
    name: '3: Scores are tallied',
    body: (
      <>
        Once all votes are cast, a score for each option is calculated reflecting the total number
        of stars that it received.
      </>
    ),
  },
  {
    name: '4: Finalists are selected',
    body: (
      <>
        The two options with the highest scores are selected as finalists
        <Footnote n={1} />.
      </>
    ),
  },
  {
    name: '5: A winner is selected',
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
    name: 'Configurable balance of privacy and transparency',
    body: <>Keep either voters or votes hidden for privacy or published for transparency.</>,
  },
  {
    name: 'Clearly explained procedure',
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
    name: 'Robust poll management',
    body: (
      <>
        Multi-question support, share with a QR code, add descriptions to options, solicit options
        from voters, and more. This site is designed to be a full-featured poll management system.
      </>
    ),
  },
  {
    name: 'Full results ranking',
    body: (
      <>
        If any options become unavailable after the poll closes, you can see their full ranking to
        pick a new winner without re-running the poll.
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
    name: 'Free and open-source',
    body: (
      <>
        This site is free to use and not monetized. It does not contain ads, trackers, or any other
        monetization scheme. It is a free and{' '}
        <Ext href="https://github.com/RobertPakko/star-voting">open-source</Ext> project.
      </>
    ),
  },
]

const PROPERTIES: Entry[] = [
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

/**
 * The two links into the sample poll, which are the whole of what a reader
 * who does not want to read gets from this page.
 *
 * They were a two-item bulleted list, which is what everything on a page is
 * when nobody has decided what it is. These are the one thing on the About
 * page anybody is meant to *do*, they are the only pair of links on it, and
 * the pair is the point: the same poll before and after it was decided.
 *
 * The votable copy leads. Reading a result of an election you have not voted
 * in explains the arithmetic; scoring five options yourself explains why the
 * arithmetic is the shape it is, and it takes about fifteen seconds.
 */
function Samples() {
  return (
    <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="md">
      <Sample
        newTab
        to={`/p/${SAMPLE_POLL_TOKEN}`}
        icon={<StarIcon />}
        gradient="standard"
        title="See a sample poll"
        body="This is what a voter sees when they open a poll."
        action="Sample poll"
      />
      <Sample
        newTab
        to={`/p/${SAMPLE_RESULT_TOKEN}`}
        icon={<TallyIcon />}
        gradient="alt"
        title="Read an example result"
        body="What everyone sees after a poll is decided."
        action="Example result"
      />
      <Sample
        to="/"
        icon={<SignInIcon />}
        gradient="create"
        title="Try it yourself"
        body="Sign in to try making and sending your own polls."
        action="Sign in"
      />
    </SimpleGrid>
  )
}

/**
 * One of the two. The card is not the link: a whole card wrapped in an anchor
 * cannot hold a button, and the button is the part that says which of these
 * is the one to press first.
 */
function Sample({
  to,
  icon,
  title,
  body,
  action,
  gradient,
  newTab = false,
}: {
  to: string
  icon: ReactNode
  title: string
  body: string
  action: string
  gradient: 'standard' | 'alt' | 'create'
  newTab?: boolean
}) {
  const gradientValue =
    gradient === 'alt'
      ? SAMPLE_ALT_GRADIENT
      : gradient === 'create'
        ? SAMPLE_CREATE_GRADIENT
        : SAMPLE_GRADIENT

  return (
    <Card withBorder radius="md" p="lg">
      <Stack gap="sm" h="100%" justify="space-between">
        <Stack gap="sm">
          <Group justify="space-between" wrap="nowrap" align="flex-start">
            <ThemeIcon size={42} radius="md" variant="gradient" gradient={gradientValue}>
              {icon}
            </ThemeIcon>
          </Group>
          <Stack gap={4}>
            <Text fw={700}>{title}</Text>
            <Text size="sm" c="dimmed">
              {body}
            </Text>
          </Stack>
        </Stack>
        <Button
          component={Link}
          to={to}
          target={newTab ? '_blank' : undefined}
          rel={newTab ? 'noopener noreferrer' : undefined}
          fullWidth
          mt="xs"
          variant="gradient"
          gradient={gradientValue}
          rightSection={<ArrowIcon />}
        >
          {action}
        </Button>
      </Stack>
    </Card>
  )
}

/** The gradient the results email already uses, so the site matches its post. */
const SAMPLE_GRADIENT = { from: 'violet', to: 'cyan', deg: 135 }
const SAMPLE_ALT_GRADIENT = { from: 'yellow', to: 'red', deg: 135 }
const SAMPLE_CREATE_GRADIENT = { from: 'green', to: 'dark', deg: 135 }

/** The bordered list every tab is made of; three lists, one shape. */
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

function StarIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={22}
      height={22}
      fill="currentColor"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z" />
    </svg>
  )
}

function TallyIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={22}
      height={22}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M4 20h16" />
      <path d="M7 20V9M12 20V4M17 20v-7" />
    </svg>
  )
}

function SignInIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={22}
      height={22}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M14 4h5v16h-5" />
      <path d="M3 12h11M10 8l4 4-4 4" />
    </svg>
  )
}

function ArrowIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
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
