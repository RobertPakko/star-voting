import { useId, useLayoutEffect, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  Anchor,
  Box,
  Button,
  Collapse,
  Divider,
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
import { useDisclosure } from '@mantine/hooks'
import { ArrowDownIcon, CaretRightIcon } from '@phosphor-icons/react'
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
 * otherwise not see the point of. The full ranking and multiple winners carry
 * on with the same friends.
 *
 * `?section=multiple-winners` opens the page at that card, for the results'
 * *Multiple winners* modal, whose reader has no use for the walkthrough above
 * it. A layout effect, so it runs after `ScrollToTop` has put the page at its
 * top.
 */
export function WhatIsStar() {
  usePageTitle('What is STAR?')
  const [params] = useSearchParams()
  const section = params.get('section')
  useLayoutEffect(() => {
    if (section) document.getElementById(section)?.scrollIntoView()
  }, [section])
  const finalists = finalistsOf(DINNER)
  const [first, second] = finalists
  const runoff = pluralityRows(DINNER, finalists, true)
  const winner = runoff.find((row) => row.won)?.name
  const loser = finalists.find((name) => name !== winner)
  const undecided = votersOf(DINNER).filter((voter) => !favoriteOf(DINNER, voter, finalists))
  const ranking = rankingOf(DINNER)
  const secondRunoff = finalistsOf(DINNER, ranking.slice(0, 1))
  const spots = spotsOf(DINNER)
  const reduced = votersOf(DINNER).filter((voter) => spots[1].weights[voter] < 1)
  return (
    <Stack maw={720} mx="auto" gap="md">
      <Title order={1}>What is STAR?</Title>
      <Stack gap="sm">
        <Text>
          <Ext href="https://en.wikipedia.org/wiki/STAR_voting">STAR</Ext> is an acronym that stands
          for &ldquo;Score Then Automatic Runoff&rdquo;. Voters score each option, the two options
          with the highest scores go to a runoff, and whichever of those two is preferred by more
          voters wins.
        </Text>
        <Text>
          Let&rsquo;s walk through it one step at a time with an example: six friends choosing what
          to have for dinner.
        </Text>
      </Stack>

      <RoundCard title="Step 1: Options defined">
        <Stack gap="sm">
          <Text>
            First, decide what is being voted on. The options can be anything: candidates for a
            position, films to watch, or times to meet. You can have as many options as you like,
            but our six friends are choosing between three:
          </Text>
          <OptionKey ratings={DINNER} />
        </Stack>
      </RoundCard>

      <RoundCard title="Step 2: Votes cast">
        <Stack gap="sm">
          <Text>
            Each voter gives every option a score from 0 to 5 stars, where 0 is the worst and 5 is
            the best. A score is not a ranking: you can give several options the same number of
            stars, and you don&rsquo;t have to use every number. A good way to start is to give your
            favorite option 5 stars and your least favorite 0 stars, then give the rest a score
            in-between. Here is the first friend&rsquo;s ballot:
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
          <Text>
            Once voting has closed, the stars each option received are added up across every ballot.
            This is the scoring round, and it measures how much support each option has across the
            group.
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
          <Text>
            The two options with the highest scores become the finalists, and every other option is
            cut. Here, {first} and {second} go through to the runoff while{' '}
            {optionsOf(DINNER)
              .filter((option) => !finalists.includes(option))
              .join(' and ')}{' '}
            is eliminated.
          </Text>
          <EmojiTable
            caption="The restaurants by score; the top two are the finalists"
            rows={finalistRows(DINNER)}
            rowLabel="Restaurant"
            totalLabel="Score"
          />
        </Stack>
      </RoundCard>

      <RoundCard title="Step 5: Winner resolved">
        <Stack gap="sm">
          <Text>
            Last comes the automatic runoff. Nobody votes again. Every ballot already says which
            finalist its voter prefers, because it&rsquo;s the one they gave more stars to. Each
            ballot counts as one vote for its preferred finalist, and the finalist with more votes
            wins. A voter who gave both finalists the same score has no preference between them, so
            their ballot counts for neither.
          </Text>
          <EmojiTable
            caption="The runoff: each friend's vote goes to the finalist they gave more stars"
            rows={runoff}
            rowLabel="Restaurant"
            totalLabel="Votes"
          />
          {undecided.map((voter) => (
            <Text key={voter} size="xs" c="dimmed" ta="center">
              The {ORDINALS[voter]} friend gave {first} and {second} {DINNER[first][voter]} stars
              each, so their ballot counts for neither.
            </Text>
          ))}
          <Text>
            The winner is {winner}, even though {loser} had more stars. This is an intentional
            feature of STAR voting. If you are curious about why STAR works this way, you should
            read more about it on the{' '}
            <Anchor component={Link} to="/why-star" inherit>
              Why STAR?
            </Anchor>{' '}
            page.
          </Text>
        </Stack>
      </RoundCard>

      <Text>
        That's generally how STAR voting works. There's no need to read-on unless you want to dive
        into the tie-breaker details and STAR extensions.
      </Text>

      <Divider label="Details & Extensions" />

      <RoundCard title="Ties">
        <Stack gap="sm">
          <Text>
            In the rare event of a tie, STAR has rules to settle it. Ties are uncommon since scores
            are totaled across all ballots, and multiple options seldom land on exactly the same
            number of stars.
          </Text>
          <Text fw={700}>A tie in the score round</Text>
          <Text>When two options are tied, the place goes to:</Text>
          <List type="ordered" spacing={4} withPadding>
            <List.Item>The one more voters prefer in a head-to-head comparison.</List.Item>
            <List.Item>If that is level too, the one given 5 stars on more ballots.</List.Item>
            <List.Item>If they are still level, one of the two is chosen at random.</List.Item>
          </List>
          <Text>
            When three or more options are tied, the head-to-head step is skipped: the places go to
            the options given 5 stars on the most ballots, and any tie left after that is settled at
            random.
          </Text>
          <Text fw={700}>A tie in the runoff</Text>
          <Text>When both finalists get the same number of votes, the winner is:</Text>
          <List type="ordered" spacing={4} withPadding>
            <List.Item>the finalist with the higher score from the scoring round;</List.Item>
            <List.Item>
              if their scores are level too, the one given 5 stars on more ballots.
            </List.Item>
          </List>
          <Text>If the finalists are level on all three, the election has no winner.</Text>
        </Stack>
      </RoundCard>

      <RoundCard title="Full ranking">
        <Stack gap="sm">
          <Text>
            STAR picks one winner, but sometimes you need a plan B: the restaurant that won is fully
            booked tonight, or the person you picked for the job turns it down. Poll results have a{' '}
            <strong>Full ranking</strong> button for this. It puts every option in order by running
            STAR again without the winner. The winner steps aside, and the next two highest scorers
            go to a runoff for second place. Then second place steps aside, and so on down the list.
          </Text>
          <Text>
            Let's show what happens with our six friends if the {winner} place is fully booked. With{' '}
            {winner} set aside, {secondRunoff[0]} and {secondRunoff[1]} are the two highest scorers
            left, so they go to a runoff for second place:
          </Text>
          <EmojiTable
            caption={`Everyone's ballots, with ${winner} set aside`}
            rows={setAside(ratingRows(DINNER, true), ranking.slice(0, 1))}
            rowLabel="Restaurant"
            totalLabel="Score"
          />
          <Then>Next two highest scorers go to a runoff</Then>
          <EmojiTable
            caption={`The runoff for second place, with ${winner} set aside`}
            rows={setAside(pluralityRows(DINNER, secondRunoff, true), ranking.slice(0, 1))}
            rowLabel="Restaurant"
            totalLabel="Votes"
          />
          <Then>The full ranking</Then>
          <Places names={ranking} />
        </Stack>
      </RoundCard>

      <Box id={MULTIPLE_WINNERS} className={classes.target}>
        <RoundCard title="Multiple winners">
          <Stack gap="sm">
            <Text>
              Sometimes a group wants more than one winner, for instance choosing two dinners on a
              weekend away or three films for a movie marathon. Using the full ranking for this can
              result in every spot going to the biggest group. The <strong>Multiple winners</strong>{' '}
              button gives a different ranking, one that shares top spots so that different groups
              of voters each get something they like:
            </Text>
            <List type="ordered" spacing={4} withPadding>
              <List.Item>Run STAR as usual to select a winner.</List.Item>
              <List.Item>
                All ballots are reweighted based on how many stars they gave the winner.
              </List.Item>
              <List.Item>
                Run STAR again on the options left, with ballots at their new strength, to select
                the next winner.
              </List.Item>
              <List.Item>Repeat until every option has a spot.</List.Item>
            </List>
            <Text>
              Let's show what happens with our six friends if we are now choosing two dinners for a
              weekend away. The first spot is plain STAR, so it&rsquo;s {spots[0].winner} again.
              Then the ballots are reweighted based on how many stars they gave {spots[0].winner}{' '}
              and we run STAR again to determine the second winner.
            </Text>
            <EmojiTable
              caption={`Everyone's ballots, with ${spots[0].winner} already chosen`}
              rows={setAside(ratingRows(DINNER, true), spots[1].chosen, DINNER)}
              rowLabel="Restaurant"
              totalLabel="Score"
            />
            <Then>Ballots are reweighted</Then>
            <EmojiTable
              caption={`The stars for the second spot, with ${spots[0].winner} already chosen`}
              rows={spotScoreRows(DINNER, spots[1])}
              rowLabel="Restaurant"
              totalLabel="Score"
              reduced={reduced}
            />
            <Text size="xs" c="dimmed" ta="center">
              The first three friends gave {spots[0].winner} 5 stars, so their ballots now count at
              half strength. The other three gave it none, so theirs still count in full.
            </Text>
            <Then>
              {labelOf(spots[1].finalists[0])} and {spots[1].finalists[1]} go to a runoff
            </Then>
            <EmojiTable
              caption="The runoff for the second spot"
              rows={spotRunoffRows(DINNER, spots[1])}
              rowLabel="Restaurant"
              totalLabel="Votes"
              reduced={reduced}
            />
            <Then>The multiple-winner ranking</Then>
            <Places names={spots.map((spot) => spot.winner)} />
            <Text>
              So the two dinners are {spots[0].winner} and {spots[1].winner}. The {spots[0].winner}{' '}
              fans had their votes reweighted in the second round to reflect that they already got
              their top choice. This way, everyone gets something that they like rather than
              allowing the largest group to choose every winner.
            </Text>
            <WeightFormula />
          </Stack>
        </RoundCard>
      </Box>
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
    <Stack maw={720} mx="auto" gap="md">
      <Title order={1}>Why use STAR?</Title>
      <Stack gap="sm">
        <Text>
          Let&rsquo;s look at an example with 9 voters choosing between 3 options for dinner: pizza,
          tacos, and sushi. The voters&rsquo; ratings of each option are shown below:
        </Text>
        <EmojiTable caption="Each voter's rating of each option" rows={ratingRows(RATINGS)} />
        <Text>
          For this group of friends, pizza is the best option. It has the highest average rating and
          it would win in a head-to-head matchup against either tacos or sushi. Suprisingly though,
          most voting systems struggle to reach this conclusion. Let's walk through them one at a
          time to learn why.
        </Text>
      </Stack>

      <RoundCard title="Plurality voting">
        <Stack gap="sm">
          <Text>
            The most common way of voting is by{' '}
            <Ext href="https://en.wikipedia.org/wiki/First-past-the-post_voting">plurality</Ext>,
            also known as &ldquo;First Past the Post&rdquo;. In our example pizza and tacos, which
            might be considered more similar to each other than to sushi, split the vote, which
            results in a win for sushi, even though 5 of the 9 voters rated sushi 1 or lower.
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
          <Text>
            <Ext href="https://en.wikipedia.org/wiki/Approval_voting">Approval voting</Ext> solves
            our vote splitting problem, but it&rsquo;s a pretty coarse representation of preference.
            In our example above, there&rsquo;s a three-way tie: each option is approved by 4
            voters.
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
          <Text>
            <Ext href="https://en.wikipedia.org/wiki/Instant-runoff_voting">
              Instant Runoff Voting
            </Ext>{' '}
            (IRV, also known as Ranked Choice Voting) prevents the vote splitting problem in a
            different way. Rather than the two pizza voters having their votes wasted, the option
            with the fewest votes is cut from the competition and its votes are reallocated
            according to the voters&rsquo; next preference. In our example, sushi still wins because
            IRV doesn&rsquo;t capture that most voters are fine with pizza despite few voters
            ranking it first. This highlights IRV&rsquo;s vulnerability to the &ldquo;
            <Ext href="https://en.wikipedia.org/wiki/Center_squeeze">center squeeze</Ext>&rdquo;
            effect, where an option that has broad support is still eliminated from the running if
            it isn&rsquo;t ranked first on enough ballots.
          </Text>
          <EmojiTable
            caption="First preferences, before anything is eliminated"
            rows={pluralityRows(RATINGS, OPTIONS, false)}
            totalLabel="Votes"
          />
          <Then>Pizza has the fewest votes, so it&rsquo;s eliminated</Then>
          <EmojiTable
            caption="Votes after the pizza votes are moved to each voter's next preference"
            rows={pluralityRows(RATINGS, IRV_SURVIVORS, true)}
            totalLabel="Votes"
          />
        </Stack>
      </RoundCard>

      <RoundCard title="Score voting">
        <Stack gap="sm">
          <Text>
            <Ext href="https://en.wikipedia.org/wiki/Score_voting">Score voting</Ext> resolves the
            center squeeze effect by taking into account all support from all voters. But score
            voting incentivizes &ldquo;
            <Ext href="https://en.wikipedia.org/wiki/Bullet_voting">bullet voting</Ext>&rdquo;,
            which is to give your favorite option the maximum score and give all other options the
            minimum score. Taco fans are incentivized to exaggerate their preference of tacos
            relative to pizza. If they dishonestly hide their partial preference for pizza, they can
            give tacos enough points to win, even though 5 of the 9 voters rated tacos 1 or lower.
            If everyone does this, then score voting regresses back into plurality voting, and sushi
            wins.
          </Text>
          <EmojiTable
            caption="Each voter's honest scores"
            rows={withWinner(ratingRows(RATINGS, true))}
            totalLabel="Score"
          />
          <Then>The taco fans bullet vote</Then>
          <EmojiTable
            caption="Each voter's scores when the taco fans bullet vote"
            rows={bulletRows((voter) => favoriteOf(RATINGS, voter, OPTIONS) === 'tacos')}
            totalLabel="Score"
          />
          <Then>Everyone bullet votes</Then>
          <EmojiTable
            caption="Each voter's scores when everyone bullet votes"
            rows={bulletRows(() => true)}
            totalLabel="Score"
          />
        </Stack>
      </RoundCard>

      <RoundCard title="STAR voting">
        <Stack gap="sm">
          <Text>
            <Ext href="https://en.wikipedia.org/wiki/STAR_voting">Score Then Automatic Runoff</Ext>{' '}
            (STAR) voting combines IRV and score voting to mitigate both the &ldquo;center
            squeeze&rdquo; effect and the &ldquo;bullet voting&rdquo; incentive. The first round
            tallies scores to find the two options with broadest support, and the second round
            establishes relative preference between these two finalists. In this example, the taco
            fans are incentivized to vote honestly. Their vote will still go entirely to tacos in
            the runoff even if they reveal their partial preference for pizza. The exaggeration that
            would benefit them in score voting provides no advantage in the runoff, where pizza
            still wins. In fact, hiding their partial preference for pizza would push pizza out of
            the runoff and result in a sushi win, a worse outcome for the taco fans.
          </Text>
          <EmojiTable
            caption="Each voter's scores, totalled; the two highest become finalists"
            rows={starScoreRows()}
            totalLabel="Score"
          />
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
          <Text>
            STAR voting resulted in the best outcome in this single, contrived election example, but
            this conclusion is supported by studies that simulate millions of elections with diverse
            election scenarios. STAR performs extremely well in these types of election simulation
            studies:
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
        <Text>
          There are other interesting voting methods such as{' '}
          <Ext href="https://en.wikipedia.org/wiki/Kemeny_method">the Kemeny method</Ext> and{' '}
          <Ext href="https://en.wikipedia.org/wiki/Schulze_method">the Schulze method</Ext>, but one
          is infeasibly computationally expensive and the other is very difficult to understand.
          STAR has the advantage of being computationally simple, easy to grasp conceptually, and
          extensible to more complex scenarios such as{' '}
          <Anchor component={Link} to="/star?section=multiple-winners" inherit>
            multi-winner elections
          </Anchor>
          .
        </Text>
      </RoundCard>
    </Stack>
  )
}

/** The *Multiple winners* card's id, which `?section=` opens the page at. */
const MULTIPLE_WINNERS = 'multiple-winners'

/**
 * The exact weight and where it comes from, folded away at the foot of the
 * *Multiple winners* card: the steps say only that a voter counts for less,
 * which is all most readers need.
 *
 * The weight is Reweighted Range Voting's, with Kok and Smith's K = 1. The
 * claim made for it here is narrow and checkable: for groups that give their
 * own options 5 and everyone else's 0, a group that has won s spots counts at
 * 1/(1 + s), which is D'Hondt's divisor sequence exactly.
 */
function WeightFormula() {
  const [opened, { toggle }] = useDisclosure(false)
  const panelId = useId()
  return (
    <Stack gap="xs">
      <Button
        variant="subtle"
        size="compact-sm"
        onClick={toggle}
        aria-expanded={opened}
        aria-controls={panelId}
        leftSection={
          <CaretRightIcon
            size={14}
            aria-hidden
            className={`${classes.caret} ${opened ? classes.caretOpen : ''}`}
          />
        }
        style={{ alignSelf: 'flex-start' }}
      >
        The reweighting formula
      </Button>
      <Collapse expanded={opened} id={panelId}>
        <Paper withBorder radius="md" p="md">
          <Stack gap="sm">
            <Text size="sm">
              A ballot&rsquo;s weight, which scales its scores and its runoff vote, is
            </Text>
            <Text size="sm" fw={600} ta="center" aria-label="1 divided by N over 5 plus 1">
              <span className={classes.fraction}>
                <span className={classes.numerator} aria-hidden="true">
                  1
                </span>
                <span className={classes.denominator} aria-hidden="true">
                  N/5 + 1
                </span>
              </span>
            </Text>
            <Text size="sm">
              where N is the total stars the ballot has given the winners so far. If you gave a
              winner 5 stars, your vote in future rounds is reduced to half of its original weight.
              If you gave two winners 5 stars each, it is reduced to one third, and so on.
            </Text>
            <Text size="sm" fw={700}>
              Why this formula
            </Text>
            <Text size="sm">
              This is the{' '}
              <Ext href="https://en.wikipedia.org/wiki/D%27Hondt_method">D&rsquo;Hondt method</Ext>{' '}
              for proportional representation, modified slightly to accomodate STAR. It&rsquo;s used
              by dozens of countries around the world to apportion seats in parliamentary elections.
            </Text>
          </Stack>
        </Paper>
      </Collapse>
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
 * `/star`'s example, used by every section of the page. Tacos leads on stars
 * but loses the runoff to pizza, and the last friend scores both finalists 0,
 * so every rule of the runoff shows. The full ranking then puts tacos second
 * (the pizza lovers' second choice), while multiple winners gives the second
 * of two dinners to sushi. The pizza lovers all gave pizza 5, so the
 * second spot weighs every ballot at 1/2 or 1, which leaves most weighted
 * scores whole; and with full-strength runoff votes they
 * would hand the second spot to tacos, which is the point the page makes
 * about weighting the runoff. The fourth friend scores tacos and sushi the
 * same so that runoff is not a tie.
 */
const DINNER: Ratings = {
  pizza: [5, 5, 5, 0, 0, 0],
  tacos: [4, 4, 2, 3, 3, 0],
  sushi: [0, 1, 0, 3, 5, 5],
}

/**
 * `/why-star`'s example, over the same three options: pizza and tacos are
 * alike, sushi is not. Pizza is the broadly liked option few put first.
 */
const RATINGS: Ratings = {
  pizza: [2, 2, 2, 2, 5, 5, 4, 4, 3],
  tacos: [1, 1, 1, 1, 0, 4, 5, 5, 5],
  sushi: [5, 5, 5, 5, 1, 0, 0, 0, 0],
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

/** STAR's two highest scorers, who go on to its runoff, leaving out any already placed. */
const finalistsOf = (ratings: Ratings, placed: readonly string[] = []): readonly string[] =>
  byScore(ratings)
    .filter((option) => !placed.includes(option))
    .slice(0, 2)
const STAR_FINALISTS = finalistsOf(RATINGS)

/** The most stars a ballot can give. */
const MAX_STARS = 5

/** Each finalist's runoff votes: one per voter who scored it higher, counted at `weights`. */
function runoffVotes(ratings: Ratings, pair: readonly string[], weights?: readonly number[]) {
  const votes = (option: string) =>
    sum(
      votersOf(ratings)
        .filter((voter) => favoriteOf(ratings, voter, pair) === option)
        .map((voter) => weights?.[voter] ?? 1),
    )
  return pair.map(votes)
}

/** The runoff's winner: the finalist with more votes. Neither example ties. */
function runoffWinner(ratings: Ratings, pair: readonly string[], weights?: readonly number[]) {
  const [a, b] = runoffVotes(ratings, pair, weights)
  return a >= b ? pair[0] : pair[1]
}

/** STAR again and again, each winner stepping aside for the next place. */
function rankingOf(ratings: Ratings) {
  const placed: string[] = []
  while (placed.length < optionsOf(ratings).length) {
    const pair = finalistsOf(ratings, placed)
    placed.push(pair.length === 1 ? pair[0] : runoffWinner(ratings, pair))
  }
  return placed
}

/** One spot of a multiple-winner count. */
interface Spot {
  /** The stars each voter gave the winners of the spots before this one. */
  given: number[]
  /** Each voter's strength going in, from `given` (`weightOf`). */
  weights: number[]
  /** Who won the spots before this one. */
  chosen: string[]
  finalists: readonly string[]
  winner: string
}

/**
 * A ballot's strength once it has given `given` stars to earlier winners:
 * 1 ÷ (1 + given ÷ 5), so a half after one 5, a third after two.
 */
const weightOf = (given: number) => 1 / (1 + given / MAX_STARS)

/** The same strength as the page writes it: an exact fraction, since every weight is one. */
function fractionOf(given: number) {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b))
  const [top, bottom] = [MAX_STARS, MAX_STARS + given]
  return `${top / gcd(top, bottom)}/${bottom / gcd(top, bottom)}`
}

/**
 * Multiple winners, as the page describes it and multi-winner-todo.md
 * specifies it: STAR once per spot until every option has one, with each
 * ballot counted, in the scores and the runoff alike, at a strength that falls
 * with the stars it gave the winners so far. Two winners are the first two
 * spots, three the first three, and so on.
 */
function spotsOf(ratings: Ratings): Spot[] {
  let given = votersOf(ratings).map(() => 0)
  const result: Spot[] = []
  while (result.length < optionsOf(ratings).length) {
    const weights = given.map(weightOf)
    const chosen = result.map((s) => s.winner)
    const total = (option: string) => weightedTotal(ratings, option, weights)
    const finalists = optionsOf(ratings)
      .filter((option) => !chosen.includes(option))
      .sort((x, y) => total(y) - total(x))
      .slice(0, 2)
    const winner = finalists.length === 1 ? finalists[0] : runoffWinner(ratings, finalists, weights)
    result.push({ given, weights, chosen, finalists, winner })
    given = given.map((stars, voter) => stars + ratings[winner][voter])
  }
  return result
}

const weightedTotal = (ratings: Ratings, option: string, weights: readonly number[]) =>
  sum(votersOf(ratings).map((voter) => ratings[option][voter] * weights[voter]))

/** A number of stars or votes as the page writes it: whole, or to one decimal place. */
const shown = (n: number) => Math.round(n * 10) / 10

/** A ballot's score at its strength: a keycap where it comes out whole, a figure otherwise. */
function weighted(score: number, weight: number): Cell {
  const worth = score * weight
  if (Number.isInteger(worth)) return keycap(worth)
  return { emoji: shown(worth), said: String(shown(worth)), figure: true }
}

/** A spot's scoring round: every ballot at its strength, earlier winners set aside. */
function spotScoreRows(ratings: Ratings, spot: Spot): Row[] {
  const rows = optionsOf(ratings).map((name): Row => ({
    name,
    cells: ratings[name].map((score, voter) => weighted(score, spot.weights[voter])),
    total: shown(weightedTotal(ratings, name, spot.weights)),
    out: !spot.finalists.includes(name),
  }))
  return setAside(rows, spot.chosen, ratings)
}

/**
 * A spot's runoff: each ballot backs the finalist it scored higher, at its
 * strength, so a vote at less than full strength is drawn as that much of a
 * square: the square cut off on the right (`partVote`), keeping its box so
 * the columns stay in line.
 */
function spotRunoffRows(ratings: Ratings, spot: Spot): Row[] {
  const votes = runoffVotes(ratings, spot.finalists, spot.weights)
  const rows = optionsOf(ratings).map((name): Row => {
    const at = spot.finalists.indexOf(name)
    if (at < 0) return { name, out: true, cells: votersOf(ratings).map(() => blank('eliminated')) }
    const cells = votersOf(ratings).map((voter): Cell => {
      if (favoriteOf(ratings, voter, spot.finalists) !== name) return blank('no vote')
      if (spot.weights[voter] === 1) return VOTE
      const unspent = `${(1 - spot.weights[voter]) * 100}%`
      return {
        emoji: (
          <span className={classes.partVote} style={{ clipPath: `inset(0 ${unspent} 0 0)` }}>
            {VOTE.emoji}
          </span>
        ),
        said: `${fractionOf(spot.given[voter])} of a vote`,
      }
    })
    return { name, cells, total: shown(votes[at]) }
  })
  return withWinner(setAside(rows, spot.chosen))
}

/**
 * Options already placed or chosen, drawn faded with their trophy and nothing
 * else. `ratings` keeps their stars on show instead of blanks, where those
 * stars are what the round turns on: the multiple-winner scores, whose
 * weights come from them.
 */
function setAside(rows: Row[], names: readonly string[], ratings?: Ratings): Row[] {
  return rows.map((row) =>
    names.includes(row.name)
      ? {
          name: row.name,
          cells: ratings ? ratings[row.name].map(keycap) : row.cells.map(() => blank('set aside')),
          aside: true,
        }
      : row,
  )
}

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
  /** A number rather than an emoji, drawn smaller and spaced. */
  figure?: boolean
}

interface Row {
  name: string
  cells: Cell[]
  total?: number
  won?: boolean
  /** Eliminated, or not a finalist: drawn struck through, with a cross. */
  out?: boolean
  /** Already placed or chosen, so out of this round without having lost it. */
  aside?: boolean
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
 * One vote per voter, for their favorite among `among`: everybody, the IRV
 * survivors, or STAR's finalists (where the favorite is whichever finalist
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

/**
 * The voters `bullets` picks give their favorite 5 and everything else 0;
 * the rest keep their honest scores.
 */
function bulletRows(bullets: (voter: number) => boolean): Row[] {
  return withWinner(
    OPTIONS.map((name) => {
      const scores = VOTERS.map((voter) =>
        !bullets(voter)
          ? RATINGS[name][voter]
          : favoriteOf(RATINGS, voter, OPTIONS) === name
            ? 5
            : 0,
      )
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
  reduced = [],
}: {
  caption: string
  /** Rows with no cells draw no voter columns: a table of totals alone. */
  rows: Row[]
  /** What a row is, said to a screen reader over the first column. */
  rowLabel?: string
  /** The last column's heading; no label, no column. */
  totalLabel?: string
  /** Voters whose ballots count for less, their faces faded. */
  reduced?: readonly number[]
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
                <span
                  aria-hidden
                  className={`${classes.emoji} ${reduced.includes(voter) ? classes.unlit : ''}`}
                >
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
              <th
                scope="row"
                className={row.out ? classes.out : row.aside ? classes.aside : undefined}
              >
                <OptionIcon name={row.name} />
              </th>
              {row.cells.map((cell, voter) => (
                <td key={voter} className={cell.figure ? classes.figure : undefined}>
                  <span aria-hidden className={classes.emoji}>
                    {cell.emoji}
                  </span>
                  <VisuallyHidden>{cell.said}</VisuallyHidden>
                </td>
              ))}
              {totalLabel && (
                <td className={`${classes.total} ${row.aside ? classes.aside : ''}`}>
                  {row.aside ? (
                    <>
                      <span aria-hidden className={classes.emoji}>
                        🏆
                      </span>
                      <VisuallyHidden>already chosen</VisuallyHidden>
                    </>
                  ) : row.out ? (
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
          {labelOf(option)}
        </Text>
      ))}
    </Group>
  )
}

/** A full ranking, in a row like `OptionKey`'s, as the ordered list it is. */
function Places({ names }: { names: readonly string[] }) {
  return (
    <Group component="ol" justify="center" gap="lg" className={classes.places}>
      {names.map((option, i) => (
        <Text component="li" key={option} fw={700}>
          {i + 1}.{' '}
          <span aria-hidden className={classes.emoji}>
            {ICONS[option]}
          </span>{' '}
          {labelOf(option)}
        </Text>
      ))}
    </Group>
  )
}

const labelOf = (option: string) => option[0].toUpperCase() + option.slice(1)

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
