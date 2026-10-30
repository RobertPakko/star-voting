import type { ReactNode } from 'react'
import {
  Anchor,
  Box,
  Card,
  Group,
  Image,
  List,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
  Title,
  VisuallyHidden,
} from '@mantine/core'
import { ArrowDownIcon } from '@phosphor-icons/react'
import { RoundCard } from '../components/RoundCard'
import { SITE_FEATURES } from '../components/siteFeatures'
import { usePageTitle } from '../lib/pageTitle'
import vseByStrategy from '../assets/why-star/vse-by-strategy.png'
import winnerDistribution from '../assets/why-star/winner-distribution.webp'
import classes from './Learn.module.css'

/**
 * The three pages that explain: what STAR voting is (`/star`), why use it
 * (`/why-star`), and what this site does with it (`/features`). Each is a
 * home-page tile of its own, so each is one short page rather than a tab of a
 * longer one. Public, because the people who most need them are the ones who
 * arrived from a share link and have never heard of the method.
 */

/**
 * STAR, one step at a time, for a reader who has never met it: each step a
 * heading over a card, as on `WhyStar`, worked through one small election
 * (`DINNER`) in the same emoji tables. The example is deliberately one where
 * the score leader loses the runoff, since that is the step a newcomer would
 * otherwise not see the point of.
 */
export function WhatIsStar() {
  usePageTitle('What is STAR?')
  const finalists = finalistsOf(DINNER)
  const [first, second] = finalists
  const runoff = pluralityRows(DINNER, finalists, true)
  const winner = runoff.find((row) => row.won)?.name
  const loser = finalists.find((name) => name !== winner)
  const undecided = votersOf(DINNER).filter((voter) => !favoriteOf(DINNER, voter, finalists))
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
        algorithms. Voters give every option a score, the two options with the most stars go to a
        runoff, and whichever of those two is preferred by more voters wins.
      </Text>
      <Text>
        Let&rsquo;s walk through it one step at a time, with an example: six friends choosing where
        to have dinner.
      </Text>

      <Stack gap="md" mt="md">
        <RoundCard title="Step 1: Options defined">
          <Stack gap="sm">
            <Text size="sm">
              First, decide what is being voted on. The options can be anything: candidates for a
              position, places to eat, films to watch, or times to meet. There can be as many as you
              like, as long as there are at least two. Our six friends are choosing between three
              options:
            </Text>
            <OptionKey ratings={DINNER} />
          </Stack>
        </RoundCard>

        <RoundCard title="Step 2: Votes cast">
          <Stack gap="sm">
            <Text size="sm">
              Each voter gives every option a score from 0 to 5 stars, where 0 is the worst and 5 is
              the best. A score is not a ranking: you can give several options the same number of
              stars, and you don&rsquo;t have to use every number. A good way to start is to give
              your favourite 5 stars and the option you like least 0, then score the rest by how
              much you like them in between. Here is the first friend&rsquo;s ballot:
            </Text>
            <Ballot ratings={DINNER} voter={0} />
            <Then>Everyone&rsquo;s ballots, side by side</Then>
            <EmojiTable
              caption="How many stars each friend gave each restaurant"
              rows={ratingRows(DINNER)}
              rowLabel="Restaurant"
            />
            <Text size="xs" c="dimmed" ta="center">
              Each column is one friend&rsquo;s ballot, and each number is how many stars they gave.
            </Text>
          </Stack>
        </RoundCard>

        <RoundCard title="Step 3: Scores tallied">
          <Stack gap="sm">
            <Text size="sm">
              Once voting has closed, the stars each option received are added up across every
              ballot. This is the scoring round, and it measures how much support each option has
              across the whole group, not only how many people put it first: an option that
              everybody likes can beat one that a few people love and the rest can&rsquo;t stand.
            </Text>
            <EmojiTable
              caption="Each restaurant's stars, added up"
              rows={ratingRows(DINNER, true)}
              rowLabel="Restaurant"
              totalLabel="Score"
            />
            <Text size="xs" c="dimmed" ta="center">
              For example, {first} gets {DINNER[first].join(' + ')} = {sum(DINNER[first])} stars.
            </Text>
          </Stack>
        </RoundCard>

        <RoundCard title="Step 4: Finalists determined">
          <Stack gap="sm">
            <Text size="sm">
              The two options with the highest scores become the finalists, and every other option
              is out. Here {first} ({sum(DINNER[first])} stars) and {second} ({sum(DINNER[second])}{' '}
              stars) go through to the runoff, and{' '}
              {optionsOf(DINNER)
                .filter((option) => !finalists.includes(option))
                .map((option) => `${option} (${sum(DINNER[option])} stars)`)
                .join(' and ')}{' '}
              is eliminated.
            </Text>
            <EmojiTable
              caption="The restaurants by score; the top two are the finalists"
              rows={finalistRows(DINNER)}
              rowLabel="Restaurant"
              totalLabel="Score"
            />
            <Text size="sm">
              Taking two finalists, rather than simply declaring the highest score the winner, is
              what sets STAR apart from plain score voting. The scores find the options with the
              broadest support; the runoff then checks which of the two the group actually prefers.
            </Text>
          </Stack>
        </RoundCard>

        <RoundCard title="Step 5: Winner resolved">
          <Stack gap="sm">
            <Text size="sm">
              Last comes the automatic runoff. Nobody votes again: every ballot already says which
              finalist its voter prefers, because it is the one they gave more stars to. Each ballot
              counts as one vote for that finalist, however big or small the difference between the
              two scores, and the finalist with more votes wins. A voter who gave both finalists the
              same score has no preference between them, so their ballot counts for neither.
            </Text>
            <EmojiTable
              caption="The runoff: each friend's vote goes to the finalist they gave more stars"
              rows={runoff}
              rowLabel="Restaurant"
              totalLabel="Votes"
            />
            {undecided.map((voter) => (
              <Text key={voter} size="xs" c="dimmed" ta="center">
                The {ORDINALS[voter]} friend <span aria-hidden>{VOTER_FACES[voter]}</span> gave{' '}
                {first} and {second} {DINNER[first][voter]} stars each, so their ballot counts for
                neither.
              </Text>
            ))}
            <Text size="sm">
              The winner is {winner}, even though {loser} had more stars. Two friends loved {loser},
              but more of the group preferred {winner} to it, and in the runoff every voter counts
              the same. This is also why you can score honestly: giving your second choice a few
              stars never takes anything away from your favourite, because if both reach the runoff,
              your whole vote goes to the one you scored higher.
            </Text>
          </Stack>
        </RoundCard>

        <RoundCard title="Ties">
          <Stack gap="sm">
            <Text size="sm">
              In the rare event of a tie, STAR has rules to settle it. Ties are uncommon because a
              score is a total over every ballot, and two options seldom land on exactly the same
              number of stars. A tie only matters where it decides something: who reaches the
              runoff, or who wins it.
            </Text>
            <Text size="sm" fw={700}>
              A tie for a place in the runoff
            </Text>
            <Text size="sm">When two options are tied, the place goes to:</Text>
            <List type="ordered" size="sm" spacing={4} withPadding>
              <List.Item>
                the one more voters prefer head-to-head, meaning more ballots gave it more stars
                than the other;
              </List.Item>
              <List.Item>if that is level too, the one given 5 stars on more ballots;</List.Item>
              <List.Item>if they are still level, one of the two, chosen at random.</List.Item>
            </List>
            <Text size="sm">
              When three or more options are tied, the head-to-head step is skipped: the places go
              to the options given 5 stars on the most ballots, and any tie left after that is
              settled at random.
            </Text>
            <Text size="sm" fw={700}>
              A tie in the runoff
            </Text>
            <Text size="sm">When both finalists get the same number of votes, the winner is:</Text>
            <List type="ordered" size="sm" spacing={4} withPadding>
              <List.Item>the finalist with the higher score from the scoring round;</List.Item>
              <List.Item>
                if their scores are level too, the one given 5 stars on more ballots.
              </List.Item>
            </List>
            <Text size="sm">
              If the finalists are level on all three, the election has no winner. This site says
              so, and offers to flip a coin to settle it, which is not part of the election.
            </Text>
          </Stack>
        </RoundCard>
      </Stack>
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
        Let&rsquo;s look at an example with 9 voters choosing between 3 options for dinner: pizza,
        tacos, and sushi. In this example, pizza and tacos are similar, while sushi is an outlier.
        The voters&rsquo; ratings of each option are shown below:
      </Text>
      <Card withBorder p="sm">
        <EmojiTable caption="Each voter's rating of each option" rows={ratingRows(RATINGS)} />
      </Card>

      <Stack gap="md" mt="md">
        <RoundCard title="Plurality voting">
          <Stack gap="sm">
            <Text size="sm">
              The most common way of voting is by{' '}
              <Ext href="https://en.wikipedia.org/wiki/First-past-the-post_voting">plurality</Ext>,
              also known as &ldquo;First Past the Post&rdquo;. In our example pizza and tacos, which
              are similar, split the vote, which results in a win for sushi, an option that 5 of the
              9 voters rated 0.
            </Text>
            <EmojiTable
              caption="Who each voter votes for under plurality voting"
              rows={pluralityRows(RATINGS, OPTIONS, true)}
              totalLabel="Votes"
            />
          </Stack>
        </RoundCard>

        <RoundCard title="Approval voting">
          <Stack gap="sm">
            <Text size="sm">
              <Ext href="https://en.wikipedia.org/wiki/Approval_voting">Approval voting</Ext> solves
              our vote splitting problem, but it&rsquo;s a pretty coarse representation of
              preference. In our example above, there&rsquo;s a three-way tie: each option is
              approved by 4 voters.
            </Text>
            <EmojiTable
              caption="Which options each voter approves of"
              rows={approvalRows()}
              totalLabel="Votes"
            />
            <Text size="xs" c="dimmed" ta="center">
              Each voter approves of the options they rated {APPROVES_FROM} or more.
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
              different way. Rather than the two voters for pizza having their votes wasted, pizza
              is cut from the competition and its votes are re-allocated according to the
              voters&rsquo; next preference. In our example tacos now win. Though this doesn&rsquo;t
              capture that all sushi fans would prefer pizza to tacos. This is an example of how
              Instant Runoff Voting is vulnerable to the &ldquo;
              <Ext href="https://en.wikipedia.org/wiki/Center_squeeze">center squeeze</Ext>&rdquo;
              effect, where an option that has broad support is still eliminated from the running if
              it doesn&rsquo;t have enough ballots where it is the first preference.
            </Text>
            <EmojiTable
              caption="First preferences, before anything is eliminated"
              rows={pluralityRows(RATINGS, OPTIONS, false)}
              totalLabel="Votes"
            />
            <Then>Pizza has the fewest votes, so it is eliminated</Then>
            <EmojiTable
              caption="Votes after the pizza votes are moved to each voter's next preference"
              rows={pluralityRows(RATINGS, IRV_SURVIVORS, true)}
              totalLabel="Votes"
            />
          </Stack>
        </RoundCard>

        <RoundCard title="Score voting">
          <Stack gap="sm">
            <Text size="sm">
              <Ext href="https://en.wikipedia.org/wiki/Score_voting">Score voting</Ext> resolves the
              center squeeze effect by taking into account all support from all voters. But score
              voting incentivizes &ldquo;
              <Ext href="https://en.wikipedia.org/wiki/Bullet_voting">bullet voting</Ext>&rdquo;,
              which is to give your favorite option the maximum score and give all other options the
              minimum score. Taco fans are incentivized to exaggerate their preference of tacos
              relative to pizza, as they don&rsquo;t want to help pizza get enough stars to beat
              tacos and win, even if they honestly feel that it&rsquo;s a decent option. With
              perfectly rational voters voting strategically, score voting can regress into
              plurality voting.
            </Text>
            <EmojiTable
              caption="Each voter's honest scores"
              rows={withWinner(ratingRows(RATINGS, true))}
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
              tallies scores to find options with broad support, and the second round establishes
              relative preference between the finalists. In this example taco fans are incentivized
              to vote honestly, since they know that their vote will still go entirely to tacos in
              the runoff, but they still want to prevent sushi from becoming a finalist. Sushi fans
              have their preference for pizza relative to tacos captured, even though their
              preferred option wasn&rsquo;t a finalist.
            </Text>
            <EmojiTable
              caption="Each voter's scores, totalled; the two highest become finalists"
              rows={starScoreRows()}
              totalLabel="Score"
            />
            <Text size="xs" c="dimmed" ta="center">
              The two highest scores belong to {STAR_FINALISTS[0]} and {STAR_FINALISTS[1]}, so they
              are the finalists.
            </Text>
            <Then>Each voter backs whichever finalist they scored higher</Then>
            <EmojiTable
              caption="The runoff between the two finalists"
              rows={pluralityRows(RATINGS, STAR_FINALISTS, true)}
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

/** One row per option, one column per voter: a whole example election. */
type Ratings = Record<string, number[]>

/**
 * `/star`'s example. The score leader (sushi) loses the runoff, and the last
 * friend scores both finalists the same, so every rule of the runoff shows.
 */
const DINNER: Ratings = {
  pizza: [2, 3, 0, 5, 1, 0],
  tacos: [0, 1, 4, 4, 5, 4],
  sushi: [5, 5, 3, 2, 3, 4],
}

/**
 * `/why-star`'s example, over the same three options: pizza and tacos are
 * alike, sushi is not. Pizza is the broadly liked option few put first.
 */
const RATINGS: Ratings = {
  pizza: [2, 2, 2, 2, 5, 5, 4, 4, 2],
  tacos: [0, 0, 0, 0, 2, 4, 5, 5, 5],
  sushi: [5, 5, 5, 5, 0, 0, 0, 0, 0],
}

/**
 * Each option's emoji, which is all a table's row heading draws (with the
 * name hidden for screen readers); `OptionKey` says which is which first.
 */
const ICONS: Record<string, string> = { pizza: '🍕', tacos: '🌮', sushi: '🍣' }

const optionsOf = (ratings: Ratings) => Object.keys(ratings)
const votersOf = (ratings: Ratings) => Object.values(ratings)[0].map((_, voter) => voter)
const OPTIONS = optionsOf(RATINGS)
const VOTERS = votersOf(RATINGS)

/**
 * A face over each voter's column, so voters and the 0–5 keycaps under them
 * are not both numbers. Single code points only: a joined sequence can come
 * apart into two glyphs where a font lacks it, and widen the column.
 */
const VOTER_FACES = ['👩', '👨', '🧑', '👵', '👴', '👧', '👦', '🧔', '👱']
const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth']

/** The lowest rating that counts as approval in the approval table. */
const APPROVES_FROM = 4

/** What is left in the instant runoff once the last-placed option is cut. */
const IRV_SURVIVORS: readonly string[] = ['tacos', 'sushi']

const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0)

/** The options by total score, highest first. Neither example ties on a total. */
const byScore = (ratings: Ratings) =>
  optionsOf(ratings).sort((x, y) => sum(ratings[y]) - sum(ratings[x]))

/** STAR's two highest scorers, who go on to its runoff. */
const finalistsOf = (ratings: Ratings): readonly string[] => byScore(ratings).slice(0, 2)
const STAR_FINALISTS = finalistsOf(RATINGS)

/** The voter's highest-rated option among `among`, or none if they rate two the same. */
function favoriteOf(ratings: Ratings, voter: number, among: readonly string[]) {
  const best = Math.max(...among.map((c) => ratings[c][voter]))
  const top = among.filter((c) => ratings[c][voter] === best)
  return top.length === 1 ? top[0] : undefined
}

/** One cell of a table: what is drawn, and what a screen reader says instead. */
interface Cell {
  emoji: ReactNode
  said: string
}

interface Row {
  name: string
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

/** The ratings as keycaps, with each option's total if asked; no winner is marked. */
function ratingRows(ratings: Ratings, withTotals = false): Row[] {
  return optionsOf(ratings).map((name) => ({
    name,
    cells: ratings[name].map(keycap),
    total: withTotals ? sum(ratings[name]) : undefined,
  }))
}

/**
 * One vote per voter, for their favourite among `among`: everybody, the IRV
 * survivors, or STAR's finalists (where the favourite is whichever finalist
 * the voter scored higher, and a voter scoring them the same votes for
 * neither). `decided` says whether to name a winner: an IRV first round with
 * no majority has none yet.
 */
function pluralityRows(ratings: Ratings, among: readonly string[], decided: boolean): Row[] {
  const voters = votersOf(ratings)
  const rows = optionsOf(ratings).map((name): Row => {
    if (!among.includes(name)) {
      return { name, out: true, cells: voters.map(() => blank('eliminated')) }
    }
    const cells = voters.map((voter) =>
      favoriteOf(ratings, voter, among) === name ? VOTE : blank('no vote'),
    )
    return { name, cells, total: cells.filter((c) => c === VOTE).length }
  })
  return decided ? withWinner(rows) : rows
}

/** STAR's scoring round: the ratings totalled, everyone but the finalists out. */
function starScoreRows(): Row[] {
  return ratingRows(RATINGS, true).map((row) => ({
    ...row,
    out: !STAR_FINALISTS.includes(row.name),
  }))
}

/** The totals alone, highest first, with everyone but the finalists out. */
function finalistRows(ratings: Ratings): Row[] {
  const finalists = finalistsOf(ratings)
  return byScore(ratings).map((name) => ({
    name,
    cells: [],
    total: sum(ratings[name]),
    out: !finalists.includes(name),
  }))
}

function approvalRows(): Row[] {
  return withWinner(
    OPTIONS.map((name) => {
      const cells = RATINGS[name].map((r) => (r >= APPROVES_FROM ? APPROVE : blank('no')))
      return { name, cells, total: cells.filter((c) => c === APPROVE).length }
    }),
  )
}

/** Every voter gives their favourite 5 and everybody else 0. */
function bulletRows(): Row[] {
  return withWinner(
    OPTIONS.map((name) => {
      const scores = VOTERS.map((voter) => (favoriteOf(RATINGS, voter, OPTIONS) === name ? 5 : 0))
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
  rowLabel = 'Option',
  totalLabel,
}: {
  caption: string
  /** Rows with no cells draw no voter columns: a table of totals alone. */
  rows: Row[]
  /** What a row is, said to a screen reader over the first column. */
  rowLabel?: string
  /** The last column's heading; no label, no column. */
  totalLabel?: string
}) {
  const voters = rows[0].cells.map((_, voter) => voter)
  return (
    <div className={classes.scroll}>
      <table className={classes.table}>
        <VisuallyHidden component="caption">{caption}</VisuallyHidden>
        <thead>
          <tr>
            <th scope="col">
              <VisuallyHidden>{rowLabel}</VisuallyHidden>
            </th>
            {voters.map((voter) => (
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
                <OptionIcon name={row.name} />
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

/** An option's emoji, with its name hidden for screen readers. */
function OptionIcon({ name }: { name: string }) {
  return (
    <>
      <span aria-hidden className={classes.emoji}>
        {ICONS[name]}
      </span>
      <VisuallyHidden>{name}</VisuallyHidden>
    </>
  )
}

/**
 * Which emoji stands for which option, before a table uses them alone. The
 * names are lower case for the prose they are read into; here each is a
 * label, so it starts with a capital.
 */
function OptionKey({ ratings }: { ratings: Ratings }) {
  return (
    <Group justify="center" gap="lg">
      {optionsOf(ratings).map((option) => (
        <Text key={option} fw={700}>
          <span aria-hidden className={classes.emoji}>
            {ICONS[option]}
          </span>{' '}
          {option[0].toUpperCase() + option.slice(1)}
        </Text>
      ))}
    </Group>
  )
}

/**
 * One voter's ballot, drawn as stars rather than keycaps, so the reader sees
 * what the numbers in the tables after it stand for.
 */
function Ballot({ ratings, voter }: { ratings: Ratings; voter: number }) {
  return (
    <div className={classes.scroll}>
      <table className={classes.table}>
        <VisuallyHidden component="caption">{`Friend ${voter + 1}'s ballot`}</VisuallyHidden>
        <tbody>
          {optionsOf(ratings).map((option) => {
            const stars = ratings[option][voter]
            return (
              <tr key={option}>
                <th scope="row">
                  <OptionIcon name={option} />
                </th>
                <td>
                  <span aria-hidden className={classes.emoji}>
                    {'⭐'.repeat(stars)}
                    <span className={classes.unlit}>{'⭐'.repeat(5 - stars)}</span>
                  </span>
                  <VisuallyHidden>{`${stars} ${stars === 1 ? 'star' : 'stars'}`}</VisuallyHidden>
                </td>
              </tr>
            )
          })}
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
      <SimpleGrid cols={{ base: 1, xs: 2 }} spacing="sm" verticalSpacing="sm">
        {SITE_FEATURES.map((f) => (
          <Paper key={f.title} withBorder p="md" radius="md">
            <Group gap="sm" wrap="nowrap" align="flex-start">
              <ThemeIcon variant="light" size={44} radius="xl">
                <f.icon size={24} aria-hidden />
              </ThemeIcon>
              <Stack gap={4}>
                <Text fw={700}>{f.title}</Text>
                <Text size="sm">{f.text}</Text>
              </Stack>
            </Group>
          </Paper>
        ))}
      </SimpleGrid>
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
