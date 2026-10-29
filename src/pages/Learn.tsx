import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  Anchor,
  Box,
  Card,
  Group,
  Image,
  List,
  Paper,
  Stack,
  Text,
  Title,
  VisuallyHidden,
} from '@mantine/core'
import { ArrowDownIcon } from '@phosphor-icons/react'
import { RoundCard } from '../components/RoundCard'
import { usePageTitle } from '../lib/pageTitle'
import { CODE_URL } from '../lib/sourceCode'
import vseByStrategy from '../assets/why-star/vse-by-strategy.png'
import winnerDistribution from '../assets/why-star/winner-distribution.webp'
import classes from './Learn.module.css'

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

/**
 * One made-up election, run through each method in turn. Every table and
 * count is worked out from `RATINGS`, so the prose is the only thing that can
 * disagree with the example; change the ratings and reread it.
 *
 * Each section is drawn as a round of the results page is (`RoundCard`: a
 * heading over a card). STAR's own rounds are emoji tables like every other
 * method's, rather than the results page's bars and chart, so the methods
 * are compared in one notation.
 */
export function WhyStar() {
  usePageTitle('Why use STAR?')
  return (
    <Stack maw={720} mx="auto" gap="sm">
      <Title order={1} mb="xs">
        Why use STAR?
      </Title>
      <Text>
        Let&rsquo;s look at an example with 9 voters and 3 candidates: Alice, Bob, and Charlie. In
        this example, Bob and Alice support similar policies, while Charlie is an outlier. The
        voters&rsquo; ratings of each candidate are shown below:
      </Text>
      <Card withBorder p="sm">
        <EmojiTable caption="Each voter's rating of each candidate" rows={ratingRows()} />
      </Card>

      <Stack gap="md" mt="md">
        <RoundCard title="Plurality voting">
          <Stack gap="sm">
            <Text size="sm">
              The most common way of voting is by{' '}
              <Ext href="https://en.wikipedia.org/wiki/First-past-the-post_voting">plurality</Ext>,
              also known as &ldquo;First Past the Post&rdquo;. In our example Alice and Bob, who are
              similar, split the vote, which results in a win for Charlie and his policies that 5 of
              the 9 voters disagree with.
            </Text>
            <EmojiTable
              caption="Who each voter votes for under plurality voting"
              rows={pluralityRows(CANDIDATES, true)}
              totalLabel="Votes"
            />
          </Stack>
        </RoundCard>

        <RoundCard title="Approval voting">
          <Stack gap="sm">
            <Text size="sm">
              <Ext href="https://en.wikipedia.org/wiki/Approval_voting">Approval voting</Ext> solves
              our vote splitting problem, but it&rsquo;s a pretty coarse representation of
              preference. In our example above, there&rsquo;s a three-way tie: each candidate is
              approved by 4 voters.
            </Text>
            <EmojiTable
              caption="Which candidates each voter approves of"
              rows={approvalRows()}
              totalLabel="Votes"
            />
            <Text size="xs" c="dimmed" ta="center">
              Each voter approves of the candidates they rated {APPROVES_FROM} or more.
            </Text>
          </Stack>
        </RoundCard>

        <RoundCard title="Instant runoff voting">
          <Stack gap="sm">
            <Text size="sm">
              <Ext href="https://en.wikipedia.org/wiki/Instant-runoff_voting">
                Instant Runoff Voting
              </Ext>{' '}
              (IRV, also known as Ranked Choice Voting) prevents the vote splitting problem in a
              different way. Rather than the two voters for Bob having their votes wasted, Bob is
              cut from the competition and his votes are re-allocated according to the voters&rsquo;
              next preference. In our example Alice now wins. Though this doesn&rsquo;t capture that
              all of Charlie&rsquo;s voters would prefer Bob to Alice. This is an example of how
              Instant Runoff Voting is vulnerable to the &ldquo;center squeeze&rdquo; effect, where
              a candidate who has broad support is still eliminated from the running if they
              don&rsquo;t have enough ballots where they are the first preference.
            </Text>
            <EmojiTable
              caption="First preferences, before anyone is eliminated"
              rows={pluralityRows(CANDIDATES, false)}
              totalLabel="Votes"
            />
            <Then>Bob has the fewest votes, so he is eliminated</Then>
            <EmojiTable
              caption="Votes after Bob's are moved to each voter's next preference"
              rows={pluralityRows(IRV_SURVIVORS, true)}
              totalLabel="Votes"
            />
          </Stack>
        </RoundCard>

        <RoundCard title="Score voting">
          <Stack gap="sm">
            <Text size="sm">
              <Ext href="https://en.wikipedia.org/wiki/Score_voting">Score voting</Ext> resolves the
              center squeeze effect by taking into account all support from all voters. But score
              voting incentivizes &ldquo;bullet voting&rdquo;, which is to give your favorite
              candidate the maximum score and give all other candidates the minimum score.
              Alice&rsquo;s fans are incentivized to exaggerate their preference of Alice relative
              to Bob, as they don&rsquo;t want to help Bob get enough points to beat Alice and win,
              even if they honestly feel that he&rsquo;s a decent candidate. With perfectly rational
              voters voting strategically, score voting can regress into plurality voting.
            </Text>
            <EmojiTable
              caption="Each voter's honest scores"
              rows={ratingRows(true)}
              totalLabel="Score"
            />
            <Then>Everyone bullet votes</Then>
            <EmojiTable
              caption="Each voter's scores when everyone bullet votes"
              rows={bulletRows()}
              totalLabel="Score"
            />
          </Stack>
        </RoundCard>

        <RoundCard title="STAR voting">
          <Stack gap="sm">
            <Text size="sm">
              <Ext href="https://en.wikipedia.org/wiki/STAR_voting">
                Score Then Automatic Runoff
              </Ext>{' '}
              (STAR) voting combines IRV and score voting to mitigate both the &ldquo;center
              squeeze&rdquo; effect and the &ldquo;bullet voting&rdquo; incentive. The first round
              tallies scores to find candidates with broad support, and the second round establishes
              relative preference between the finalists. In this example Alice&rsquo;s voters are
              incentivized to vote honestly, since they know that their vote will still go entirely
              to Alice in the runoff, but they still want to prevent Charlie from becoming a
              finalist. Charlie&rsquo;s fans have their preference for Bob relative to Alice
              captured, even though their preferred candidate wasn&rsquo;t a finalist.
            </Text>
            <EmojiTable
              caption="Each voter's scores, totalled; the two highest become finalists"
              rows={starScoreRows()}
              totalLabel="Score"
            />
            <Text size="xs" c="dimmed" ta="center">
              {STAR_FINALISTS[0]} and {STAR_FINALISTS[1]} have the two highest scores, so they are
              the finalists.
            </Text>
            <Then>Each voter backs whichever finalist they scored higher</Then>
            <EmojiTable
              caption="The runoff between the two finalists"
              rows={pluralityRows(STAR_FINALISTS, true)}
              totalLabel="Votes"
            />
          </Stack>
        </RoundCard>

        <RoundCard title="Other simulated elections">
          <Stack gap="sm">
            <Text size="sm">
              STAR voting resulted in the best outcome in this single, contrived election example,
              but this conclusion is supported by studies that simulate millions of elections with
              diverse election scenarios. STAR performs extremely well in diverse simulated
              elections:
            </Text>
            <Figure
              src={vseByStrategy}
              alt="Chart of voter satisfaction efficiency for 3-2-1 voting, STAR, approval, IRV and plurality voting under six voter strategies. STAR stays between about 0.91 and 0.98 under every strategy, while IRV falls as low as 0.60 and plurality to about 0.72."
              credit={
                <>
                  How satisfied voters are with the winner under each method, as voters vote more
                  strategically. Chart by Jameson Quinn, from the{' '}
                  <Ext href="https://electionscience.github.io/vse-sim/VSEbasic">
                    Voter Satisfaction Efficiency Simulator
                  </Ext>
                  , maintained by{' '}
                  <Ext href="https://electionscience.org">The Center for Election Science</Ext>.
                </>
              }
            />
            <Figure
              src={winnerDistribution}
              alt="Heat maps of where the winner falls across a million simulated two-dimensional elections. Plurality, top-two runoff and ranked-choice voting form a ring around the centre of the voters, while approval, Borda, Coombs, STAR and Condorcet voting cluster at the centre, like the best possible winner."
              credit={
                <>
                  Where the winner falls when voters and candidates are spread across a
                  two-dimensional political spectrum, reproducing Merrill (1985).{' '}
                  <Ext href="https://commons.wikimedia.org/wiki/File:Center_squeeze_grid.png">
                    &ldquo;Center squeeze grid&rdquo;
                  </Ext>{' '}
                  by Closed Limelike Curves, via Wikimedia Commons, licensed under{' '}
                  <Ext href="https://creativecommons.org/licenses/by-sa/4.0/">CC BY-SA 4.0</Ext>.
                </>
              }
            />
          </Stack>
        </RoundCard>

        <RoundCard title="Other voting methods">
          <Text size="sm">
            There are other interesting voting methods such as{' '}
            <Ext href="https://en.wikipedia.org/wiki/Kemeny_method">the Kemeny method</Ext> and{' '}
            <Ext href="https://en.wikipedia.org/wiki/Schulze_method">the Schulze method</Ext>, but
            one is infeasibly computationally expensive and the other is very difficult to
            understand. STAR has the advantage of being both computationally simple and easy to
            grasp conceptually.
          </Text>
        </RoundCard>
      </Stack>
    </Stack>
  )
}

/** A step from one table to the next, said in a few words beside the arrow. */
function Then({ children }: { children: ReactNode }) {
  return (
    <Group gap={6} justify="center" wrap="nowrap">
      <ArrowDownIcon size={18} aria-hidden style={{ flexShrink: 0 }} />
      <Text size="sm" c="dimmed">
        {children}
      </Text>
    </Group>
  )
}

/**
 * A simulation's chart, with what it shows and whose work it is under it.
 * The credit names the author, the title and where it is published, and the
 * licence where there is one (CC BY-SA asks for all four).
 */
function Figure({ src, alt, credit }: { src: string; alt: string; credit: ReactNode }) {
  return (
    <Stack component="figure" gap={4} m={0}>
      <Image src={src} alt={alt} radius="sm" />
      <Text component="figcaption" size="xs" c="dimmed">
        {credit}
      </Text>
    </Stack>
  )
}

const CANDIDATES = ['Alice', 'Bob', 'Charlie'] as const
type Candidate = (typeof CANDIDATES)[number]

/** One row per candidate, one column per voter: the whole example. */
const RATINGS: Record<Candidate, number[]> = {
  Alice: [0, 0, 0, 0, 2, 4, 5, 5, 5],
  Bob: [2, 2, 2, 2, 5, 5, 4, 4, 2],
  Charlie: [5, 5, 5, 5, 0, 0, 0, 0, 0],
}
const VOTERS = RATINGS.Alice.map((_, voter) => voter)

/**
 * A face over each voter's column, so voters and the 0–5 keycaps under them
 * are not both numbers. Single code points only: a joined sequence can come
 * apart into two glyphs where a font lacks it, and widen the column.
 */
const VOTER_FACES = ['👩', '👨', '🧑', '👵', '👴', '👧', '👦', '🧔', '👱']

/** The lowest rating that counts as approval in the approval table. */
const APPROVES_FROM = 4

/** Who is left in the instant runoff once the last-placed candidate is cut. */
const IRV_SURVIVORS: readonly Candidate[] = ['Alice', 'Charlie']

const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0)

/** STAR's two highest scorers, who go on to its runoff. */
const STAR_FINALISTS: readonly Candidate[] = [...CANDIDATES]
  .sort((x, y) => sum(RATINGS[y]) - sum(RATINGS[x]))
  .slice(0, 2)

/** The voter's highest-rated candidate among `among`. Nobody in the example ties. */
const favoriteOf = (voter: number, among: readonly Candidate[]) =>
  among.reduce((best, c) => (RATINGS[c][voter] > RATINGS[best][voter] ? c : best))

/** One cell of a table: what is drawn, and what a screen reader says instead. */
interface Cell {
  emoji: ReactNode
  said: string
}

interface Row {
  name: Candidate
  cells: Cell[]
  total?: number
  won?: boolean
  /** Eliminated, or not a finalist: drawn struck through, with a cross. */
  out?: boolean
}

const keycap = (n: number): Cell => ({ emoji: `${n}️⃣`, said: String(n) })
const VOTE: Cell = { emoji: '🟩', said: 'vote' }
const APPROVE: Cell = { emoji: '🟩', said: 'approves' }
// An empty square in the page's own colour, so "no vote" reads as a gap
// rather than as a mark in either scheme.
const blank = (said: string): Cell => ({
  emoji: (
    <>
      <Box component="span" darkHidden>
        ⬜
      </Box>
      <Box component="span" lightHidden>
        ⬛
      </Box>
    </>
  ),
  said,
})

/** The highest total, marked as the winner only if nobody shares it. */
function withWinner(rows: Row[]): Row[] {
  const best = Math.max(...rows.map((r) => r.total ?? -1))
  const leaders = rows.filter((r) => r.total === best)
  return rows.map((r) => ({ ...r, won: leaders.length === 1 && r === leaders[0] }))
}

function ratingRows(withTotals = false): Row[] {
  const rows = CANDIDATES.map((name) => ({
    name,
    cells: RATINGS[name].map(keycap),
    total: withTotals ? sum(RATINGS[name]) : undefined,
  }))
  return withTotals ? withWinner(rows) : rows
}

/**
 * One vote per voter, for their favourite among `among`: everybody, the IRV
 * survivors, or STAR's finalists (where the favourite is whichever finalist
 * the voter scored higher). `decided` says whether to name a winner: an IRV
 * first round with no majority has none yet.
 */
function pluralityRows(among: readonly Candidate[], decided: boolean): Row[] {
  const rows = CANDIDATES.map((name): Row => {
    if (!among.includes(name)) {
      return { name, out: true, cells: VOTERS.map(() => blank('eliminated')) }
    }
    const cells = VOTERS.map((voter) =>
      favoriteOf(voter, among) === name ? VOTE : blank('no vote'),
    )
    return { name, cells, total: cells.filter((c) => c === VOTE).length }
  })
  return decided ? withWinner(rows) : rows
}

/** STAR's scoring round: the ratings totalled, everyone but the finalists out. */
function starScoreRows(): Row[] {
  return ratingRows(true).map((row) => ({
    ...row,
    won: false,
    out: !STAR_FINALISTS.includes(row.name),
  }))
}

function approvalRows(): Row[] {
  return withWinner(
    CANDIDATES.map((name) => {
      const cells = RATINGS[name].map((r) => (r >= APPROVES_FROM ? APPROVE : blank('no')))
      return { name, cells, total: cells.filter((c) => c === APPROVE).length }
    }),
  )
}

/** Every voter gives their favourite 5 and everybody else 0. */
function bulletRows(): Row[] {
  return withWinner(
    CANDIDATES.map((name) => {
      const scores = VOTERS.map((voter) => (favoriteOf(voter, CANDIDATES) === name ? 5 : 0))
      return { name, cells: scores.map(keycap), total: sum(scores) }
    }),
  )
}

/**
 * The example as a grid of emoji. A real table underneath, so a screen
 * reader walks it by candidate and voter and hears each cell's `said`.
 */
function EmojiTable({
  caption,
  rows,
  totalLabel,
}: {
  caption: string
  rows: Row[]
  /** The last column's heading; no label, no column. */
  totalLabel?: string
}) {
  return (
    <div className={classes.scroll}>
      <table className={classes.table}>
        <VisuallyHidden component="caption">{caption}</VisuallyHidden>
        <thead>
          <tr>
            <th scope="col">
              <VisuallyHidden>Candidate</VisuallyHidden>
            </th>
            {VOTERS.map((voter) => (
              <th key={voter} scope="col">
                <span aria-hidden className={classes.emoji}>
                  {VOTER_FACES[voter]}
                </span>
                <VisuallyHidden>Voter {voter + 1}</VisuallyHidden>
              </th>
            ))}
            {totalLabel && (
              <th scope="col" className={classes.total}>
                {totalLabel}
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.name}>
              <th scope="row" className={row.out ? classes.out : undefined}>
                {row.name}
              </th>
              {row.cells.map((cell, voter) => (
                <td key={voter}>
                  <span aria-hidden className={classes.emoji}>
                    {cell.emoji}
                  </span>
                  <VisuallyHidden>{cell.said}</VisuallyHidden>
                </td>
              ))}
              {totalLabel && (
                <td className={classes.total}>
                  {row.out ? (
                    <>
                      {row.total !== undefined && `${row.total} `}
                      <span aria-hidden className={classes.emoji}>
                        ❌
                      </span>
                      <VisuallyHidden>eliminated</VisuallyHidden>
                    </>
                  ) : (
                    <>
                      {row.total}
                      {row.won && (
                        <>
                          {' '}
                          <span aria-hidden className={classes.emoji}>
                            🏆
                          </span>
                          <VisuallyHidden>, the winner</VisuallyHidden>
                        </>
                      )}
                    </>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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

/** The bordered list the other two pages are made of; two lists, one shape. */
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
