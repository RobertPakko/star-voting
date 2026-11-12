import { useId, useLayoutEffect, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  Accordion,
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Collapse,
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
  type MantineColor,
} from '@mantine/core'
import { useDisclosure } from '@mantine/hooks'
import {
  ArrowDownIcon,
  ArrowsSplitIcon,
  CaretRightIcon,
  CirclesThreeIcon,
  ChartPieSliceIcon,
  CpuIcon,
  CoinsIcon,
  EyeIcon,
  HandshakeIcon,
  ListNumbersIcon,
  RankingIcon,
  RepeatIcon,
  TrophyIcon,
  UsersThreeIcon,
  WarningIcon,
  type Icon,
} from '@phosphor-icons/react'
import { RoundCard } from '../components/RoundCard'
import { SITE_FEATURES } from '../components/siteFeatures'
import { badgeColor } from '../lib/badgeColors'
import { usePageTitle } from '../lib/pageTitle'
import { percentagesOf } from '../lib/shares'
import { stars } from '../lib/plural'
import { pollPath } from '../lib/pollId'
import {
  SAMPLE_RESULT_ID,
  SAMPLE_RESULT_TIME_ID,
  SAMPLE_SEQUEL_ASSIGNMENT_ID,
  SAMPLE_SEQUEL_BUDGET_ID,
  SAMPLE_SEQUEL_ID,
  sampleResultAs,
} from '../lib/samplePoll'
import type { ResultTool } from '../lib/choices'
import vseByStrategy from '../assets/why-star/vse-by-strategy.png'
import winnerDistribution from '../assets/why-star/winner-distribution.webp'
import classes from './Learn.module.css'

/**
 * The four pages that explain: what STAR voting is and how it settles a tie
 * (`/star`), what else the same ballots can answer (`/choices`), why use it
 * (`/why-star`), and what this site does with it (`/features`). Each is a
 * home-page tile of its own, so each is one short page rather than a tab of
 * a longer one. Public, because
 * the people who most need them are the ones who arrived from a share link and
 * have never heard of the method.
 */

/**
 * Opens the page at the card `?section=` names, for links that want one card
 * of a long page (the result's modals, the old `/ties` address). A layout
 * effect, so it runs after `ScrollToTop` has put the page at its top.
 */
function useSection() {
  const [params] = useSearchParams()
  const section = params.get('section')
  useLayoutEffect(() => {
    if (section) document.getElementById(section)?.scrollIntoView()
  }, [section])
  return section
}

/** The id of `WhatIsStar`'s tie-break card, which `/ties` redirects to. */
const TIES = 'ties'

/**
 * STAR, one step at a time, for a reader who has never met it: each step a
 * heading over a card, as on `WhyStar`, worked through one small election
 * (`DINNER`) in the same emoji tables. The example is deliberately one where
 * the score leader loses the runoff, since that is the step a newcomer would
 * otherwise not see the point of. The tie-break rules follow the steps, as
 * one card most readers never need; they are the ones `star_round` and the
 * runoff apply, so change them here, in the SQL and in `test/sql/cases/`
 * together. `AllChoices` carries on with the same friends.
 */
export function WhatIsStar() {
  usePageTitle('What is STAR?')
  useSection()
  const finalists = finalistsOf(DINNER)
  const [first, second] = finalists
  const runoff = pluralityRows(DINNER, finalists, true)
  const winner = runoff.find((row) => row.won)?.name
  const loser = finalists.find((name) => name !== winner)
  const undecided = votersOf(DINNER).filter((voter) => !favoriteOf(DINNER, voter, finalists))
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
              The {ORDINALS[voter]} friend gave {first} and {second} {stars(DINNER[first][voter])}{' '}
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

      <Box id={TIES} className={classes.target}>
        <RoundCard title="Ties">
          <Stack gap="sm">
            <Text>
              In the rare event of a tie, STAR has rules to settle it. Ties are uncommon since
              scores are totaled across all ballots, and multiple options seldom land on exactly the
              same number of stars. A tie can happen in either round.
            </Text>
            <Text fw={700}>A tie in the scoring round</Text>
            <Text>When two options are tied, the place goes to:</Text>
            <List type="ordered" spacing={4} withPadding>
              <List.Item>The one more voters prefer in a head-to-head comparison.</List.Item>
              <List.Item>If that is level too, the one given 5 stars on more ballots.</List.Item>
              <List.Item>If they are still level, one of the two is chosen at random.</List.Item>
            </List>
            <Text>
              When three or more options are tied, the head-to-head step is skipped: the places go
              to the options given 5 stars on the most ballots, and any tie left after that is
              settled at random.
            </Text>
            <Text fw={700}>A tie in the runoff</Text>
            <Text>When both finalists get the same number of votes, the winner is:</Text>
            <List type="ordered" spacing={4} withPadding>
              <List.Item>the finalist with the higher score from the scoring round;</List.Item>
              <List.Item>
                if their scores are level too, the one given 5 stars on more ballots.
              </List.Item>
            </List>
            <Text>
              If the finalists are level on all three, the election has no winner. A poll&rsquo;s
              results then offer a <strong>Flip a coin</strong> button, which picks one of the two
              finalists. The coin lands the same way for everyone who flips it, but it isn&rsquo;t
              part of the election: the poll still says it has no winner.
            </Text>
          </Stack>
        </RoundCard>
      </Box>
    </Stack>
  )
}

/**
 * Every question the same star ballots can answer, one section each. Unlike
 * the other explainers, the sections do not build on each other, so each is
 * folded away under its heading, with the algorithms it runs on as tags that
 * show while it is closed. The page opens with all of them closed, except the
 * one `?section=` names (the result's modals link to their own), which opens
 * already expanded. A link to another section while the page is up opens that
 * one too, keeping whatever the reader had open.
 *
 * The sections that work an example carry on with `/star`'s six friends,
 * whose ballots are restated above the sections for a reader who arrived from
 * a result. A choice that is not built yet says so and works no example.
 * Each number a choice needs on an option or voter has its own word: a
 * *cost* (out of a budget) or a number of *places* (voters an option can go
 * to, or matches a voter can take).
 */
export function AllChoices() {
  usePageTitle('All choices')
  const section = useSection()
  const [open, setOpen] = useState<string[]>(() => (section ? [section] : []))
  // A new `?section=` while mounted opens that section too, during render
  // rather than in an effect, so it is open on the frame the page scrolls.
  const [opened, setOpened] = useState(section)
  if (section !== opened) {
    setOpened(section)
    if (section && !open.includes(section)) setOpen([...open, section])
  }
  const finalists = finalistsOf(DINNER)
  const winner = runoffWinner(DINNER, finalists)
  const ranking = rankingOf(DINNER)
  const secondRunoff = finalistsOf(DINNER, ranking.slice(0, 1))
  const spots = spotsOf(DINNER)
  const reduced = votersOf(DINNER).filter((voter) => spots[1].weights[voter] < 1)
  const consensus = floorRows(DINNER).find((row) => row.won)!.name
  const [pair, ...otherPairs] = consensusSetsOf(DINNER, 2)
  const weeks = weeksOf([DINNER, DINNER, DINNER, WITH_LATECOMER])
  const latecomer = votersOf(DINNER).length
  const shares = sharesOf(DINNER)
  const percent = percentagesOf(shares)
  const budget = budgetOf(DINNER, COSTS, BUDGET)
  const budgetReduced = votersOf(DINNER).filter((voter) => budget.spots[1].weights[voter] < 1)
  const popular = byPopularity(DINNER, COSTS, BUDGET)
  const given = assignmentOf(DINNER, SERVINGS)

  return (
    <Stack maw={720} mx="auto" gap="md">
      <Title order={1}>All choices</Title>
      <Stack gap="sm">
        <Text>
          The same set of ballots can answer a wide variety of interesting questions about a given
          group. This page shows all of the choices supported by this app, when it makes sense to
          use them, and how they work. To help explain them we'll look at each one through the lens
          of our six friends deciding between three options for dinner:
        </Text>
        <OptionKey ratings={DINNER} />
        <Text>Here's how they voted:</Text>
        <EmojiTable
          caption="How many stars each friend gave each restaurant"
          rows={ratingRows(DINNER, true)}
          rowLabel="Restaurant"
        />
      </Stack>

      <Accordion
        multiple
        value={open}
        onChange={setOpen}
        variant="separated"
        order={2}
        classNames={{
          item: classes.choice,
          control: classes.choiceControl,
          label: classes.choiceLabel,
          content: classes.choiceContent,
        }}
      >
        <Choice
          id={CHOICES.bestOption}
          icon={TrophyIcon}
          color="yellow"
          title="Best option"
          example="option"
          algorithms={['STAR']}
        >
          <Text>
            Sometimes a group has many options and must pick one. <strong>Best option</strong> picks
            one option using STAR, a very clever procedure that ameliorates many of the issues found
            in other voting methods.
          </Text>
          <Text>
            <Anchor component={Link} to="/star" inherit>
              What is STAR?
            </Anchor>{' '}
            walks through the procedure one step at a time, and{' '}
            <Anchor component={Link} to="/why-star" inherit>
              Why STAR?
            </Anchor>{' '}
            explains why it's so powerful.
          </Text>
          <Text>
            The app also has a <strong>best time</strong> option. It uses exactly the same procedure
            but the options are presented on a calendar to make voting easier.
          </Text>
        </Choice>

        <Choice
          id={CHOICES.consensusOption}
          icon={HandshakeIcon}
          color="teal"
          title="Consensus option"
          example="consensus"
          algorithms={['Maximin']}
        >
          <NotStrategyProof />
          <Text>
            Sometimes the best option is the one that nobody hates: a meeting time everyone can make
            or a dinner that no one is allergic to. <strong>Consensus option</strong> picks the
            option whose worst score is as good as possible:
          </Text>
          <List type="ordered" spacing={4} withPadding>
            <List.Item>
              Each option gets a score equal to the fewest stars it was given by any one voter.
            </List.Item>
            <List.Item>The option with the highest score wins.</List.Item>
          </List>
          <Text>
            Here are our six friends&rsquo; ballots again, with each option's lowest score(s)
            circled:
          </Text>
          <EmojiTable
            caption="Each restaurant's fewest stars from any one friend"
            rows={floorRows(DINNER)}
            rowLabel="Restaurant"
            totalLabel="Lowest"
          />
          <Text>
            For our six friends, {consensus} is the consensus option since everyone gave it at least{' '}
            {stars(Math.min(...DINNER[consensus]))}, while{' '}
            {optionsOf(DINNER)
              .filter((option) => option !== consensus)
              .join(' and ')}{' '}
            were each given 0 stars by someone. This also shows why this system is easy to game. A
            voter can give every option except their favorite 0 stars to force the group into a
            specific option; though hopefully no one would do that for a poll among friends.
          </Text>
          <Text>
            If several options tie, then the next lowest rating given to each of the tied options is
            used to break the tie. This continues until a winner is found. If all scores are
            exhausted and several options still tie, then there is no winner. Comparing options this
            way is called the{' '}
            <Ext href="https://en.wikipedia.org/wiki/Leximin_order">leximin order</Ext>. The app
            lets you flip a coin to choose one.
          </Text>
          <Text>
            The app also has a <strong>consensus time</strong> option. It uses exactly the same
            procedure but the options are presented on a calendar to make voting easier.
          </Text>
        </Choice>

        <Choice
          id={CHOICES.consensusWinners}
          icon={CirclesThreeIcon}
          color="cyan"
          title="Consensus winners"
          example="consensus_winners"
          algorithms={['Egalitarian Chamberlin–Courant']}
        >
          <NotStrategyProof />
          <Text>
            Sometimes a group picks several options and each person only needs one of them: a few
            sessions of a class so everyone can make one, or several dinners so everyone gets one
            they enjoy. <strong>Consensus winners</strong> picks several options together so that
            the voter they serve worst is served as well as possible:
          </Text>
          <List type="ordered" spacing={4} withPadding>
            <List.Item>
              Each voter is served by the option in the set that they gave the most stars.
            </List.Item>
            <List.Item>
              The set whose worst-served voter has the most stars wins. If several sets tie, the
              next worst-served voter is compared, and so on (the{' '}
              <Ext href="https://en.wikipedia.org/wiki/Leximin_order">leximin order</Ext> again).
            </List.Item>
            <List.Item>Sets that still tie go to the one with the most stars in total.</List.Item>
          </List>
          <Text>
            Say our six friends will go out for dinner twice. Here are their ballots for{' '}
            {pair.names.join(' and ')}, with the option that serves each friend circled:
          </Text>
          <EmojiTable
            caption={`Each friend's favorite of ${pair.names.join(' and ')}`}
            rows={servedRows(DINNER, pair.names)}
            rowLabel="Restaurant"
          />
          <Text>
            Everyone gets a dinner they gave at least {stars(Math.min(...pair.served))}.{' '}
            {otherPairs
              .map(
                (other) =>
                  `${other.names.join(' and ')} would leave someone with only ${stars(Math.min(...other.served))}`,
              )
              .join(', and ')}
            . Notice that {consensus}, the consensus option, is not one of the two: a pair can serve
            everyone better than any one option can.
          </Text>
          <Text>
            Unlike multiple winners, the best three are not always the best two plus one more, so
            each number of winners is worked out on its own. Finding the best set is a hard problem
            in general: the app checks every set it has to, and on very large polls asks for fewer
            winners rather than guess. Like the consensus option, it is easy to game: a voter who
            gives everything but their favorite 0 stars can force that favorite into the set.
          </Text>
          <Text>
            The app also has a <strong>consensus times</strong> option, which picks several times on
            a calendar, so that everyone can make at least one.
          </Text>
        </Choice>

        <Choice
          id={CHOICES.optionRanking}
          icon={ListNumbersIcon}
          color="blue"
          title="Option ranking"
          example="ranking"
          algorithms={['Iterative STAR']}
        >
          <Text>
            STAR picks one winner, but sometimes you need a plan B: the restaurant that won is fully
            booked or the person you picked for the job turns it down.{' '}
            <strong>Option ranking</strong> puts every option in order by running STAR again without
            the winner. The winner steps aside, and the next two highest scorers go to a runoff for
            second place. Then second place steps aside, and so on down the list.
          </Text>
          <Text>
            Let&rsquo;s show what happens with our six friends if the {winner} place is fully
            booked. With {winner} set aside, {secondRunoff[0]} and {secondRunoff[1]} are the two
            highest scorers left, so they go to a runoff for second place:
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
          <Then>The option ranking</Then>
          <Places names={ranking} />
        </Choice>

        <Choice
          id={CHOICES.multipleWinners}
          icon={RankingIcon}
          color="violet"
          title="Multiple winners"
          example="multiple"
          algorithms={['Iterative STAR', 'Ballot reweighting']}
        >
          <Text>
            Sometimes a group wants more than one winner: choosing two dinners on a weekend away or
            three films for a movie marathon. Taking the top of the option ranking for this can
            result in every spot going to the biggest group. <strong>Multiple winners</strong> gives
            a ranking that shares top spots so that different groups of voters each get something
            they like:
          </Text>
          <List type="ordered" spacing={4} withPadding>
            <List.Item>Run STAR as usual to select a winner.</List.Item>
            <List.Item>
              All ballots are reweighted based on how many stars they gave the winner.
            </List.Item>
            <List.Item>
              Run STAR again on the options left, with ballots at their new strength, to select the
              next winner.
            </List.Item>
            <List.Item>Repeat until every option has a spot.</List.Item>
          </List>
          <Text>
            Let&rsquo;s show what happens with our six friends if we are now choosing two dinners
            for a weekend away. The first spot is plain STAR, so it&rsquo;s {spots[0].winner}. Then
            the ballots are reweighted based on how many stars they gave {spots[0].winner} and we
            run STAR again to determine the second winner.
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
            their top choice. This way, everyone gets something that they like rather than allowing
            the largest group to choose every winner.
          </Text>
          <WeightFormula />
        </Choice>

        <Choice
          id={CHOICES.sequentialPolls}
          icon={RepeatIcon}
          color="cyan"
          title="Sequential polls"
          algorithms={['Iterative STAR', 'Ballot reweighting']}
          example="sequential"
        >
          <Requirement icon={UsersThreeIcon}>
            We have the voters and ballots from a previous poll
          </Requirement>
          <Text>
            Sometimes choices are recurring: what to eat at a weekly dinner or who hosts the next
            meeting. Always running a fresh poll lets the biggest group win every time.{' '}
            <strong>Sequential polls</strong> take into account the results of previous polls, with
            every ballot reweighted by how much its voter liked the previous winners.
          </Text>
          <Text>
            This uses exactly the same procedure as <strong>multiple winners</strong>, but spread
            across several polls. Over time wins are shared out among different groups.
          </Text>
          <Text>
            Let&rsquo;s say our six friends now have dinner every week and run a poll each time,
            voting the same way every week. Without reweighting, {winner} would win every single
            week. With sequential polls, the first four weeks go like this:
          </Text>
          <Weeks weeks={weeks} />
          <Then>How much each friend&rsquo;s ballot counted each week</Then>
          <EmojiTable
            caption="Each friend's ballot strength, week by week, beside the dinner that week chose"
            rows={weekRows(weeks)}
            rowLabel="Week"
          />
          <Text size="xs" c="dimmed" ta="center">
            Each row is a week. Every ballot starts at full strength and its strength is reduced
            each time a dinner it liked wins.
          </Text>
          <Text>
            In week {weeks.length}, a {ORDINALS[latecomer]} friend joins, giving{' '}
            {optionsOf(WITH_LATECOMER)
              .map((option) => `${option} ${stars(WITH_LATECOMER[option][latecomer])}`)
              .join(', ')
              .replace(/, ([^,]*)$/, ' and $1')}
            . Any voter joining late gets the average weight of the ballots already there, so
            joining late neither helps nor hurts
          </Text>
          <Text>
            Ballots are also re-normalized for display purposes. This doesn't change the result, but
            makes it easier to read if the weights have become very small over time.
          </Text>
          <WeightFormula />
        </Choice>

        <Choice
          id={CHOICES.fractionalWinners}
          icon={ChartPieSliceIcon}
          color="grape"
          title="Fractional winners"
          example="fractional"
          algorithms={['Nash', 'Newton’s method']}
        >
          <Text>
            Sometimes options can be taken partially rather than entirely: a playlist shared between
            genres or a permanent split between different dinner options.{' '}
            <strong>Fractional winners</strong> computes the fairest split of options when it's
            possible to take a little of each.
          </Text>
          <List type="ordered" spacing={4} withPadding>
            <List.Item>
              Consider a voter&rsquo;s satisfaction with each option's result to be the fraction it
              won multiplied by what they rated that option.
            </List.Item>
            <List.Item>
              Consider a voter&rsquo;s total satisfaction to be the sum of their satisfaction for
              each option's result.
            </List.Item>
            <List.Item>
              The split is then chosen such that every voter&rsquo;s total satisfaction, multiplied
              together, is as large as possible.
            </List.Item>
          </List>
          <Text>
            Let&rsquo;s show what happens with our six friends if they now meet for dinner every
            week and want to decide how often to go to each place. Here are their ballots again,
            with each restaurant&rsquo;s share of the weeks in the last column:
          </Text>
          <EmojiTable
            caption="How many stars each friend gave each restaurant, and each restaurant's share of the weeks"
            rows={shareRows(DINNER, percent)}
            rowLabel="Restaurant"
            totalLabel="Share"
          />
          <Then>Each friend&rsquo;s satisfaction</Then>
          <EmojiTable
            caption="Each friend's stars times each restaurant's share, added up, and those sums multiplied together"
            rows={satisfactionRows(DINNER, percent)}
            rowLabel="Restaurant"
            totalLabel="Product"
          />
          <Text size="xs" c="dimmed" ta="center">
            332 is the highest possible product of the friends&rsquo; satisfaction scores, so this
            is the fairest split of the options.
          </Text>
          <Text>
            So the friends split their weeks{' '}
            {sharesInOrder(percent)
              .map((option) => `${percent[option]}% ${option}`)
              .join(', ')
              .replace(/, ([^,]*)$/, ' and $1')}
            .
          </Text>
          <Shares percent={percent} />
          <Text>
            Notice how {winner} has the smallest share even though it would win a STAR election.
            This is because alternating between options that different groups prefer can lead to
            greater satisfaction than picking one compromise to stick with permanently. This is the
            detail that <strong>fractional winners</strong> tries to capture.
          </Text>
          <Text>
            This app provides a way to randomly select an option once you have your fractional
            winners. This allows you to just pick an option randomly when you need to make a
            decision rather than having everyone fill out a poll each time. Across many decisions
            the set of randomized results approaches the optimal split.
          </Text>
          <NashFormula />
        </Choice>

        <Choice
          id={CHOICES.proportionalBudget}
          icon={CoinsIcon}
          color="green"
          title="Proportional budget"
          algorithms={['Iterative STAR', 'Ballot reweighting', 'Cost adjustment']}
          example="budget"
        >
          <NeedsCost />
          <Text>
            Sometimes options can have differing costs: activities for a trip with a fixed budget or
            talks at a one-day conference. Funding the most popular options in order lets the
            biggest group spend the whole budget. <strong>Proportional budget</strong> shares the
            budget so that different groups of voters each get something they like:
          </Text>
          <List type="ordered" spacing={4} withPadding>
            <List.Item>
              Run STAR to select a winner, with scores reweighted to adjust for cost.
            </List.Item>
            <List.Item>
              All ballots are reweighted based on how many stars they gave the funded options and
              the cost of those options.
            </List.Item>
            <List.Item>
              Run cost-adjusted STAR again on the options left, with ballots at their new strength,
              to select the next winner.
            </List.Item>
            <List.Item>Repeat until nothing left fits in the budget.</List.Item>
          </List>
          <Text>
            Let&rsquo;s say our six friends are now throwing a party with a ${BUDGET} food budget,
            and each restaurant&rsquo;s party platter costs:
          </Text>
          <Costs costs={COSTS} />
          <Text>
            The average cost is ${averageCost(COSTS)}. Each star is multiplied by the average cost
            divided by the option&rsquo;s cost, so a cheaper option&rsquo;s stars count for more:{' '}
            {optionsOf(DINNER)
              .map((option) => `${option} ×${decimal(averageCost(COSTS) / COSTS[option])}`)
              .join(', ')}
            . The scoring round adds up the scaled stars:
          </Text>
          <EmojiTable
            caption="Everyone's stars, scaled by each restaurant's cost"
            rows={spotScoreRows(budget.adjusted, budget.spots[0])}
            rowLabel="Restaurant"
            totalLabel="Score"
          />
          <Then>
            {labelOf(budget.spots[0].finalists[0])} and {budget.spots[0].finalists[1]} go to a
            runoff
          </Then>
          <EmojiTable
            caption="The runoff for the first option funded"
            rows={spotRunoffRows(DINNER, budget.spots[0])}
            rowLabel="Restaurant"
            totalLabel="Votes"
          />
          <Text>
            {labelOf(budget.spots[0].winner)} is funded, leaving $
            {BUDGET - COSTS[budget.spots[0].winner]}. Then every ballot is reweighted by how many
            stars it gave {budget.spots[0].winner}, scaled by {budget.spots[0].winner}&rsquo;s cost,
            and STAR runs again on the options that still fit:
          </Text>
          <EmojiTable
            caption={`The scaled stars for the second option funded, with ${budget.spots[0].winner} already funded`}
            rows={spotScoreRows(budget.adjusted, budget.spots[1])}
            rowLabel="Restaurant"
            totalLabel="Score"
            reduced={budgetReduced}
          />
          <Then>
            {labelOf(budget.spots[1].finalists[0])} and {budget.spots[1].finalists[1]} go to a
            runoff
          </Then>
          <EmojiTable
            caption="The runoff for the second option funded"
            rows={spotRunoffRows(DINNER, budget.spots[1])}
            rowLabel="Restaurant"
            totalLabel="Votes"
            reduced={budgetReduced}
          />
          <Text>
            {labelOf(budget.spots[1].winner)} is funded, leaving ${budget.left}, which is not enough
            for anything else, so the count stops there.
          </Text>
          <Places names={budget.spots.map((spot) => spot.winner)} />
          <Text>
            Funding the most popular options in order would have bought {popular.join(' and ')},
            spending the whole budget on the options the {budget.spots[0].winner} fans like most.
            Instead, both groups get their favorite.
          </Text>
          <Text>
            Including cost in the reweighting step means a group that gets one expensive option
            funded has spent as much of its influence as a group that gets several cheap ones.
          </Text>
          <Text>
            Each option is either fully funded or left out, so some of the budget can be left
            unspent.
          </Text>
          <Text>
            Voters aren't shown the cost of each option, they are expected to provide a rating
            without considering the cost since the cost is automatically accounted for by the
            procedure.
          </Text>
          <BudgetFormula />
        </Choice>

        <Choice
          id={CHOICES.optionAssignment}
          icon={ArrowsSplitIcon}
          color="orange"
          title="Option assignment"
          algorithms={['Nash', 'Hungarian method']}
          example="assignment"
        >
          <Requirement icon={EyeIcon}>The poll shows who voted.</Requirement>
          <Text>
            Sometimes voters should be assigned to different options: separate projects that must be
            staffed or different activities that can be done simultaneously.{' '}
            <strong>Option assignment</strong> assigns each voter to an option, choosing the
            assignment that leaves the group as satisfied as possible:
          </Text>
          <List type="ordered" spacing={4} withPadding>
            <List.Item>
              Each option may be given a capacity: how many voters can be assigned to it.
            </List.Item>
            <List.Item>
              The assignment chosen is the one where the stars each voter gave their assigned
              option, multiplied together, are as large as possible.
            </List.Item>
          </List>
          <Text>
            Let&rsquo;s say our six friends have ordered food to share, one serving each, but there
            isn&rsquo;t much of each:
          </Text>
          <Servings servings={SERVINGS} />
          <Text>Here are their ballots again, with the food each friend is given circled:</Text>
          <EmojiTable
            caption="How many stars each friend gave each food, with the one each friend is given circled"
            rows={givenRows(DINNER, SERVINGS, given)}
            rowLabel="Food"
            totalLabel="Given"
          />
          <Text size="xs" c="dimmed" ta="center">
            5,625 is the highest possible product of the friends&rsquo; satisfaction scores, so this
            is the fairest assignment.
          </Text>
          <Text>
            The numbers don&rsquo;t have to match. If there are more voters than the combined option
            capacities, as many voters as possible are given an option and the rest go without. If
            there are more places than voters, every voter gets one and some places are left empty.
            A voter is only given an option they gave 0 stars when nothing they starred has a place
            left.
          </Text>
          <Text>
            A poll can also give each voter more than one option, up to its{' '}
            <strong>Max options per voter</strong>. The options are then handed out in rounds. Each
            round gives every voter at most one more option, choosing the assignment that raises the
            product of everyone&rsquo;s total stars the most. Voters with fewer stars so far come
            first, since a few more stars multiply their satisfaction by more. Rounds continue until
            every place is filled or every voter has as many options as they can be given.
          </Text>
          <Alert variant="light" color="orange" icon={<CpuIcon size={20} aria-hidden />}>
            <Text size="sm">
              With more than one option per voter, the assignment found might not have the highest
              possible product. Finding the best one is an{' '}
              <Ext href="https://en.wikipedia.org/wiki/Integer_programming">
                integer programming
              </Ext>{' '}
              problem, computationally infeasible for all but the smallest polls, so each round
              settles for the best next step.
            </Text>
          </Alert>
          <AssignmentFormula />
        </Choice>
      </Accordion>
    </Stack>
  )
}

/**
 * One section of `AllChoices`: its icon, title and algorithm tags in the
 * heading, which is the button that opens it. The tags sit inside the button
 * so they show while the section is closed; they read after the title.
 */
function Choice({
  id,
  icon: Glyph,
  color,
  title,
  algorithms,
  example,
  children,
}: {
  id: string
  icon: Icon
  /** The icon's colour, a different one per section so the folded list is easy to scan. */
  color: MantineColor
  title: string
  algorithms: string[]
  /**
   * The result in the sample poll that shows this choice, for a choice that is
   * built; `sequential` is the sample's sequel.
   */
  example?: ResultTool | 'sequential'
  children: ReactNode
}) {
  return (
    <Accordion.Item value={id} id={id} className={classes.target}>
      <Accordion.Control
        icon={
          <ThemeIcon size={40} radius="md" variant="light" color={color}>
            <Glyph size={22} aria-hidden />
          </ThemeIcon>
        }
      >
        {/* The title and tags together are the icon's 40px: 20 + 2 + 18. */}
        <Stack gap={2}>
          <Text fw={700} size="md" lh="20px">
            {title}
          </Text>
          <Group gap={4}>
            <VisuallyHidden>{algorithms.length > 1 ? 'Algorithms:' : 'Algorithm:'}</VisuallyHidden>
            {algorithms.map((name) => (
              <Badge key={name} size="sm" variant="light" color={badgeColor.algorithm}>
                {name}
              </Badge>
            ))}
          </Group>
        </Stack>
      </Accordion.Control>
      <Accordion.Panel>
        <Stack gap="sm">
          {children}
          {example && (
            <Group justify="flex-end">
              <Button component={Link} to={exampleFor(example)} variant="light">
                See an example
              </Button>
            </Group>
          )}
        </Stack>
      </Accordion.Panel>
    </Accordion.Item>
  )
}

/**
 * Where a built choice is shown on the finished sample poll, opening on that
 * choice as though the question had asked for it: the consensus on its
 * calendar question, which did ask for the consensus time; the best option
 * on the film question, which asked for it; and the rest on the film
 * question recast as that kind (`sampleResultAs`). The two the first poll
 * cannot show are the sequel's questions: its film question is sequential,
 * its upgrades question a proportional budget and its last an option
 * assignment.
 */
function exampleFor(tool: ResultTool | 'sequential') {
  if (tool === 'sequential') return pollPath(SAMPLE_SEQUEL_ID)
  if (tool === 'budget') return pollPath(SAMPLE_SEQUEL_BUDGET_ID)
  if (tool === 'assignment') return pollPath(SAMPLE_SEQUEL_ASSIGNMENT_ID)
  if (tool === 'consensus') return pollPath(SAMPLE_RESULT_TIME_ID)
  if (tool === 'option') return pollPath(SAMPLE_RESULT_ID)
  return pollPath(sampleResultAs(tool))
}

/**
 * The warning on a choice a voter can do better under by scoring dishonestly,
 * which STAR's runoff guards against. `easily` where one ballot's extreme
 * scores can carry the result on their own.
 */
function NotStrategyProof() {
  return (
    <Alert variant="light" color="orange" icon={<WarningIcon size={20} aria-hidden />}>
      <Text size="sm">Warning: not resistant to strategic voting.</Text>
    </Alert>
  )
}

/** Something a choice needs from its poll beyond a list of options. */
function Requirement({ icon: Glyph, children }: { icon: Icon; children: ReactNode }) {
  return (
    <Alert
      variant="light"
      color="gray"
      icon={<Glyph size={20} aria-hidden />}
      title="Additional requirement"
    >
      <Text size="sm">{children}</Text>
    </Alert>
  )
}

function NeedsCost() {
  return <Requirement icon={CoinsIcon}>Options have different costs.</Requirement>
}

/**
 * The ids of `AllChoices`' sections, which `?section=` opens the page at.
 * The result's modals link to them by these words, so keep them.
 */
const CHOICES = {
  bestOption: 'best-option',
  consensusOption: 'consensus-option',
  consensusWinners: 'consensus-winners',
  optionRanking: 'option-ranking',
  multipleWinners: 'multiple-winners',
  sequentialPolls: 'sequential-polls',
  proportionalBudget: 'proportional-budget',
  fractionalWinners: 'fractional-winners',
  optionAssignment: 'option-assignment',
}

/**
 * *Proportional budget*'s weight, folded away at the foot of its section as
 * `WeightFormula` is under *Multiple winners*: the same divisor, with each
 * funded option's stars scaled by its cost over the average cost of every
 * option on the poll, so an option of average cost charges a ballot exactly
 * as a Multiple winners spot does.
 */
function BudgetFormula() {
  return (
    <Folded label="The reweighting formula">
      <Text size="sm">
        A ballot&rsquo;s weight, which scales its scores and its runoff vote, is
      </Text>
      <Text
        size="sm"
        fw={600}
        ta="center"
        aria-label="5 divided by 5 plus the sum, over funded options, of stars times cost over average cost"
      >
        <span className={classes.fraction}>
          <span className={classes.numerator} aria-hidden="true">
            5
          </span>
          <span className={classes.denominator} aria-hidden="true">
            5 + Σ (N<sub>i</sub> × C<sub>i</sub>/A)
          </span>
        </span>
      </Text>
      <Text size="sm">
        The influence lost for previous winners is N<sub>i</sub> times C<sub>i</sub>/A where N
        <sub>i</sub> is the stars given to the winner of round i, C<sub>i</sub> is the cost of the
        winner of round i, and A is the average cost of every option on the poll. Summing these
        values over all previous winners gives the total influence lost, which we add to the
        denominator.
      </Text>
      <Text size="sm">
        Note that if every option costs the same, this expression collapses to the exact same
        expression used in <strong>multiple winners</strong>. Giving 5 stars to an option that costs
        half the average loses half as much influence. Giving 5 stars to an option that costs twice
        the average loses twice as much influence.
      </Text>
    </Folded>
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
          extensible to more complex scenarios. Learn more about what STAR can do beyond choosing
          one option by checking out all the types of{' '}
          <Anchor component={Link} to="/choices" inherit>
            choices
          </Anchor>{' '}
          supported by this app.
        </Text>
      </RoundCard>
    </Stack>
  )
}

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
  return (
    <Folded label="The reweighting formula">
      <Text size="sm">
        A ballot&rsquo;s weight, which scales its scores and its runoff vote, is
      </Text>
      <Text size="sm" fw={600} ta="center" aria-label="5 divided by 5 plus N">
        <span className={classes.fraction}>
          <span className={classes.numerator} aria-hidden="true">
            5
          </span>
          <span className={classes.denominator} aria-hidden="true">
            5 + N
          </span>
        </span>
      </Text>
      <Text size="sm">
        where N is the total stars the ballot has given the winners so far. If you gave a winner 5
        stars, your vote in future rounds is reduced to half of its original weight. If you gave two
        winners 5 stars each, it is reduced to one third, and so on.
      </Text>
      <Text size="sm" fw={700}>
        Why this formula
      </Text>
      <Text size="sm">
        This is the{' '}
        <Ext href="https://en.wikipedia.org/wiki/D%27Hondt_method">D&rsquo;Hondt method</Ext> for
        proportional representation, modified slightly to accommodate STAR. It&rsquo;s used by
        dozens of countries around the world to apportion seats in parliamentary elections. Applied
        to score voting without STAR&rsquo;s runoff, the same weight is known as{' '}
        <Ext href="https://en.wikipedia.org/wiki/Reweighted_range_voting">
          reweighted range voting
        </Ext>
        .
      </Text>
    </Folded>
  )
}

/**
 * The Nash welfare written out, folded away at the foot of the *Fractional
 * winners* card as `WeightFormula` is at the foot of *Multiple winners*.
 *
 * The claim made for it is narrow and checkable: where voters split into
 * groups that each give their own option 5 and every other 0, maximising
 * Σ size × log(share) gives each option exactly its group's fraction.
 */
function NashFormula() {
  return (
    <Folded label="The satisfaction formula">
      <Text size="sm">
        If option i gets share P<sub>i</sub> and voter j gave it N<sub>ij</sub> stars, voter
        j&rsquo;s satisfaction is
      </Text>
      <Text size="sm" fw={600} ta="center">
        u<sub>j</sub> = P<sub>1</sub>N<sub>1j</sub> + P<sub>2</sub>N<sub>2j</sub> + …
      </Text>
      <Text size="sm">and the shares chosen are the ones that make the largest</Text>
      <Text size="sm" fw={600} ta="center">
        u<sub>1</sub> × u<sub>2</sub> × … × u<sub>n</sub>
      </Text>
      <Text size="sm" fw={700}>
        Why this formula
      </Text>
      <Text size="sm">
        Multiplying makes the shares proportional. If the voters split into groups that each give
        their own favorite 5 stars and everything else 0, every option&rsquo;s share is exactly the
        fraction of voters in its group. A group that also likes other options gives up some of its
        share to them, since it is satisfied by those too. This is the{' '}
        <Ext href="https://en.wikipedia.org/wiki/Nash_welfare_rule">Nash welfare</Ext> solution to
        the{' '}
        <Ext href="https://en.wikipedia.org/wiki/Cooperative_bargaining">
          cooperative bargaining
        </Ext>{' '}
        problem.
      </Text>
      <Text size="sm" fw={700}>
        How the shares are found
      </Text>
      <Text size="sm">
        The logarithm of the product is a{' '}
        <Ext href="https://en.wikipedia.org/wiki/Concave_function">concave function</Ext> of the
        shares, so it has a single peak and climbing uphill from anywhere reaches it. The app climbs
        with{' '}
        <Ext href="https://en.wikipedia.org/wiki/Newton%27s_method_in_optimization">
          Newton&rsquo;s method
        </Ext>
        , which uses the curvature of the product to jump most of the way to the peak in each step.
        A share that would drop below 0 is set to 0 and that option leaves the split, and an option
        left out comes back in if a little of it would raise the product. A handful of steps is
        usually enough. To keep it fast, only the ten options with the most stars are shared
        between.
      </Text>
    </Folded>
  )
}

/**
 * How *Option assignment* is solved, folded away at the foot of its card as
 * `NashFormula` is at the foot of *Fractional winners*. It says what
 * `poll_assignment` does: one round is an assignment problem solved exactly
 * by the Hungarian method on logarithms of stars, and several rounds are a
 * greedy run of those.
 */
function AssignmentFormula() {
  return (
    <Folded label="How it’s solved">
      <Text size="sm">
        With one option per voter, this is the{' '}
        <Ext href="https://en.wikipedia.org/wiki/Assignment_problem">assignment problem</Ext>:
        matching voters to places so that a total is as large as possible. Taking the logarithm of
        each voter&rsquo;s stars turns the product into a total, since log(a × b) = log a + log b,
        so the largest product is the largest total of logarithms.
      </Text>
      <Text size="sm">
        The app solves that exactly with the{' '}
        <Ext href="https://en.wikipedia.org/wiki/Hungarian_algorithm">Hungarian method</Ext>. It
        adds voters one at a time, and for each finds the cheapest chain of swaps that frees a place
        for them. Before the product, it gives as many voters as possible an option they starred,
        since a voter with 0 stars would make the whole product 0.
      </Text>
      <Text size="sm">
        With several options per voter, each round is an assignment problem of its own, scored by
        how much each new option multiplies the stars its voter already holds. Taking the best round
        each time is a{' '}
        <Ext href="https://en.wikipedia.org/wiki/Greedy_algorithm">greedy algorithm</Ext>: quick,
        and usually close to the best answer, but not always the best.
      </Text>
    </Folded>
  )
}

/**
 * A card's working, folded away under a button at its foot, for the reader
 * who wants the exact rule rather than the steps.
 */
function Folded({ label, children }: { label: string; children: ReactNode }) {
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
        {label}
      </Button>
      <Collapse expanded={opened} id={panelId}>
        <Paper withBorder radius="md" p="md">
          <Stack gap="sm">{children}</Stack>
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
 * but loses the runoff to pizza, and the last friend scores both finalists 1,
 * so every rule of the runoff shows. That 1 is also what makes tacos the
 * consensus option: everybody gave it at least 1, and pizza and sushi were
 * each given 0 by somebody; raising pizza with it keeps that friend
 * undecided in the runoff. The full ranking then puts tacos second (the pizza
 * lovers' second choice), while multiple winners gives the second of two
 * dinners to sushi. The pizza lovers all gave pizza 5, so the second spot
 * weighs their ballots at 1/2 (and the last friend's at 5/6); with
 * full-strength runoff votes they would hand the second spot to tacos, which
 * is the point the page makes about weighting the runoff. The fourth friend
 * scores tacos and sushi the same so that runoff is not a tie.
 * `48_multiple_winners` and `49_fractional_winners` count the same ballots.
 */
const DINNER: Ratings = {
  pizza: [5, 5, 5, 0, 0, 1],
  tacos: [4, 4, 2, 3, 3, 1],
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
const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh']

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
function runoffVotes(
  ratings: Ratings,
  pair: readonly string[],
  weights?: readonly number[],
  scale?: Record<string, number>,
) {
  const votes = (option: string) =>
    sum(
      votersOf(ratings)
        .filter((voter) => favoriteOf(ratings, voter, pair) === option)
        .map((voter) => (weights?.[voter] ?? 1) * (scale?.[option] ?? 1)),
    )
  return pair.map(votes)
}

/**
 * The runoff's winner: the finalist with more votes, each vote counted at its
 * ballot's weight and, under a budget, its finalist's cost scale. Neither
 * example ties.
 */
function runoffWinner(
  ratings: Ratings,
  pair: readonly string[],
  weights?: readonly number[],
  scale?: Record<string, number>,
) {
  const [a, b] = runoffVotes(ratings, pair, weights, scale)
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

/** One spot of a multiple-winner count, or one option funded from a proportional budget. */
interface Spot {
  /** Each voter's strength going in, from what they gave the winners before this one. */
  weights: number[]
  /** The same strengths as the page writes them: exact fractions. */
  fractions: string[]
  /** Under a budget, what each option's runoff votes are multiplied by: average cost over its cost. */
  scale?: Record<string, number>
  /** Who won the spots before this one. */
  chosen: string[]
  finalists: readonly string[]
  winner: string
}

/**
 * A ballot's strength once it has given `given` stars to earlier winners:
 * 5 ÷ (5 + given), so a half after one 5, a third after two.
 */
const weightOf = (given: number) => 1 / (1 + given / MAX_STARS)

/** The same strength as the page writes it: an exact fraction, since every weight is one. */
function fractionOf(given: number) {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b))
  const [top, bottom] = [MAX_STARS, MAX_STARS + given]
  return `${top / gcd(top, bottom)}/${bottom / gcd(top, bottom)}`
}

/**
 * Multiple winners, as the page describes it and `poll_multiple_winners`
 * counts it (stopping at ten spots): STAR once per spot, with each
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
    result.push({ weights, fractions: given.map(fractionOf), chosen, finalists, winner })
    given = given.map((stars, voter) => stars + ratings[winner][voter])
  }
  return result
}

/**
 * The example budget for *Proportional budget*: each restaurant's platter
 * for a party. Chosen so the order matters: pizza is funded first, and the
 * last $30 then goes to sushi rather than tacos, where funding the options
 * by popularity alone would buy pizza and tacos.
 */
const COSTS: Record<string, number> = { pizza: 20, tacos: 30, sushi: 25 }
const BUDGET = 50

/** The average cost of every option on the poll, which a cost is measured against. */
const averageCost = (costs: Record<string, number>) =>
  sum(Object.values(costs)) / Object.keys(costs).length

/**
 * Every star scaled by the average cost over the option's cost, so an option
 * costing half the average counts each star twice. The scoring round is run
 * on these; the runoff takes each voter's preference from their own stars and
 * scales the vote by the same factor (`Spot.scale`).
 */
function costAdjusted(ratings: Ratings, costs: Record<string, number>): Ratings {
  const average = averageCost(costs)
  return Object.fromEntries(
    optionsOf(ratings).map((o) => [o, ratings[o].map((stars) => (stars * average) / costs[o])]),
  )
}

/** A strength as an exact fraction where a small one is exact, else to two decimal places. */
function ratioOf(x: number) {
  if (x === 1) return '1/1'
  for (let bottom = 2; bottom <= 1000; bottom++) {
    const top = Math.round(x * bottom)
    if (Math.abs(top / bottom - x) < 1e-9) return `${top}/${bottom}`
  }
  return String(Math.round(x * 100) / 100)
}

/**
 * Proportional budget, as the page describes it: cost-adjusted STAR once per
 * option funded, among the options that still fit in what is left, with each
 * ballot's strength 5 ÷ (5 + Σ stars × cost ÷ average cost) over what it
 * funded so far (`BudgetFormula`). Stops when nothing left fits.
 */
function budgetOf(ratings: Ratings, costs: Record<string, number>, budget: number) {
  const adjusted = costAdjusted(ratings, costs)
  const average = averageCost(costs)
  const scale = Object.fromEntries(optionsOf(ratings).map((o) => [o, average / costs[o]]))
  let lost = votersOf(ratings).map(() => 0)
  let left = budget
  const spots: Spot[] = []
  for (;;) {
    const weights = lost.map((l) => 1 / (1 + l))
    const chosen = spots.map((spot) => spot.winner)
    const total = (option: string) => weightedTotal(adjusted, option, weights)
    const finalists = optionsOf(ratings)
      .filter((option) => !chosen.includes(option) && costs[option] <= left)
      .sort((x, y) => total(y) - total(x))
      .slice(0, 2)
    if (finalists.length === 0) break
    const winner =
      finalists.length === 1 ? finalists[0] : runoffWinner(ratings, finalists, weights, scale)
    spots.push({ weights, fractions: weights.map(ratioOf), chosen, finalists, winner, scale })
    left -= costs[winner]
    lost = lost.map(
      (l, voter) => l + (ratings[winner][voter] / MAX_STARS) * (costs[winner] / average),
    )
  }
  return { adjusted, spots, left }
}

/** What funding the options in STAR's ranking order, while they fit, would buy instead. */
function byPopularity(ratings: Ratings, costs: Record<string, number>, budget: number) {
  const bought: string[] = []
  let left = budget
  for (const option of rankingOf(ratings)) {
    if (costs[option] <= left) {
      bought.push(option)
      left -= costs[option]
    }
  }
  return bought
}

/** Each option's cost, in a row like `OptionKey`'s. */
/**
 * *Option assignment*'s example: food the friends ordered to share, three
 * slices of pizza, two tacos and one sushi roll, so all six friends get one
 * and two of them want the one roll.
 */
const SERVINGS: Record<string, number> = { pizza: 3, tacos: 2, sushi: 1 }

/** What one serving and several of each food are called, for `Servings`. */
const SERVING_WORDS: Record<string, [string, string]> = {
  pizza: ['slice of pizza', 'slices of pizza'],
  tacos: ['taco', 'tacos'],
  sushi: ['sushi roll', 'sushi rolls'],
}

/**
 * Each voter's option (null for none), worked out by trying every way of
 * handing them out: the most voters given an option they gave a star, then
 * the largest product of their stars, then the most stars. Six friends and
 * three foods are 4^6 ways; `poll_assignment` does it properly, and
 * `55_option_assignment` counts the same example.
 */
function assignmentOf(ratings: Ratings, places: Record<string, number>): (string | null)[] {
  const options = optionsOf(ratings)
  const voters = votersOf(ratings)
  let best: (string | null)[] = voters.map(() => null)
  let bestScore = [0, 1, 0]
  const choice: (string | null)[] = voters.map(() => null)
  const visit = (voter: number) => {
    if (voter === voters.length) {
      const given = voters.flatMap((v) => (choice[v] ? [ratings[choice[v]!][v]] : []))
      const score = [given.length, given.reduce((a, b) => a * b, 1), sum(given)]
      const better = score.findIndex((s, i) => s !== bestScore[i])
      if (better !== -1 && score[better] > bestScore[better]) {
        best = [...choice]
        bestScore = score
      }
      return
    }
    for (const option of [...options, null]) {
      if (option !== null) {
        if (ratings[option][voter] === 0) continue
        if (choice.filter((c) => c === option).length >= places[option]) continue
      }
      choice[voter] = option
      visit(voter + 1)
    }
    choice[voter] = null
  }
  visit(0)
  return best
}

/** The ratings, with each voter's own option circled and each option's places filled. */
function givenRows(
  ratings: Ratings,
  places: Record<string, number>,
  given: (string | null)[],
): Row[] {
  return optionsOf(ratings).map((name) => ({
    name,
    cells: ratings[name].map((score, voter) => ({
      ...keycap(score),
      marked: given[voter] === name,
      said: given[voter] === name ? `${score}, given this one` : String(score),
    })),
    total: `${given.filter((option) => option === name).length}/${places[name]}`,
  }))
}

/** How much there is of each food, drawn as `Costs` draws costs. */
function Servings({ servings }: { servings: Record<string, number> }) {
  return (
    <Group component="ul" justify="center" gap="lg" className={classes.places}>
      {Object.keys(servings).map((option) => (
        <Text component="li" key={option} fw={700}>
          <span aria-hidden className={classes.emoji}>
            {ICONS[option]}
          </span>{' '}
          {servings[option]} {SERVING_WORDS[option][servings[option] === 1 ? 0 : 1]}
        </Text>
      ))}
    </Group>
  )
}

function Costs({ costs }: { costs: Record<string, number> }) {
  return (
    <Group component="ul" justify="center" gap="lg" className={classes.places}>
      {Object.keys(costs).map((option) => (
        <Text component="li" key={option} fw={700}>
          <span aria-hidden className={classes.emoji}>
            {ICONS[option]}
          </span>{' '}
          {labelOf(option)} ${costs[option]}
        </Text>
      ))}
    </Group>
  )
}

const weightedTotal = (ratings: Ratings, option: string, weights: readonly number[]) =>
  sum(votersOf(ratings).map((voter) => ratings[option][voter] * weights[voter]))

/** A number of stars or votes as the page writes it: whole, or to one decimal place. */
const shown = (n: number) => Math.round(n * 10) / 10

/**
 * A ballot's score at its strength: a keycap where it comes out whole, a
 * figure otherwise, or a figure always where `plain` (a table that is almost
 * all figures, where a few keycaps among them read as a different kind of cell).
 */
function weighted(score: number, weight: number, plain = false): Cell {
  const worth = score * weight
  if (Number.isInteger(worth) && !plain) return keycap(worth)
  return { emoji: shown(worth), said: String(shown(worth)), figure: true }
}

/**
 * A spot's scoring round: every ballot at its strength, earlier winners set
 * aside. Under a budget every cell is scaled by cost, so nearly all are
 * fractional and all are written as figures.
 */
function spotScoreRows(ratings: Ratings, spot: Spot): Row[] {
  const rows = optionsOf(ratings).map((name): Row => ({
    name,
    cells: ratings[name].map((score, voter) =>
      weighted(score, spot.weights[voter], Boolean(spot.scale)),
    ),
    total: shown(weightedTotal(ratings, name, spot.weights)),
    out: !spot.finalists.includes(name),
  }))
  return setAside(rows, spot.chosen)
}

/**
 * A spot's runoff: each ballot backs the finalist it scored higher, at its
 * strength, so a vote at less than full strength is drawn as that much of a
 * square: the square cut off on the right (`partVote`), keeping its box so
 * the columns stay in line.
 */
function spotRunoffRows(ratings: Ratings, spot: Spot): Row[] {
  const votes = runoffVotes(ratings, spot.finalists, spot.weights, spot.scale)
  const rows = optionsOf(ratings).map((name): Row => {
    const at = spot.finalists.indexOf(name)
    if (at < 0) return { name, out: true, cells: votersOf(ratings).map(() => blank('eliminated')) }
    const cells = votersOf(ratings).map((voter): Cell => {
      if (favoriteOf(ratings, voter, spot.finalists) !== name) return blank('no vote')
      // Under a budget a vote can be worth more than one, so it is written as
      // the figure it counts for rather than drawn as part of a square.
      if (spot.scale) {
        const worth = spot.weights[voter] * spot.scale[name]
        return { emoji: decimal(worth), said: `${decimal(worth)} of a vote`, figure: true }
      }
      if (spot.weights[voter] === 1) return VOTE
      const unspent = `${(1 - spot.weights[voter]) * 100}%`
      return {
        emoji: (
          <span className={classes.partVote} style={{ clipPath: `inset(0 ${unspent} 0 0)` }}>
            {VOTE.emoji}
          </span>
        ),
        said: `${spot.fractions[voter]} of a vote`,
      }
    })
    return { name, cells, total: shown(votes[at]) }
  })
  return withWinner(setAside(rows, spot.chosen))
}

/**
 * Fractional winners, as the page describes it: the share of each option that
 * makes the product of every voter's average stars largest. Found by the
 * multiplicative update for mixture weights, p ← p × mean(s ÷ u), which climbs
 * the (concave) log of the product from any starting point with every share
 * above 0. A voter who gave everything 0 is satisfied by no shares, so is left
 * out rather than holding the product at 0.
 */
function sharesOf(ratings: Ratings): Record<string, number> {
  const options = optionsOf(ratings)
  const voters = votersOf(ratings).filter((voter) => options.some((o) => ratings[o][voter] > 0))
  let shares = options.map(() => 1 / options.length)
  for (let step = 0; step < 2000; step++) {
    const satisfied = voters.map((voter) =>
      sum(options.map((option, j) => shares[j] * ratings[option][voter])),
    )
    shares = shares.map(
      (share, j) =>
        (share * sum(voters.map((voter, i) => ratings[options[j]][voter] / satisfied[i]))) /
        voters.length,
    )
  }
  return Object.fromEntries(options.map((option, j) => [option, shares[j]]))
}

/** A voter's average stars under `shares`. */
const satisfactionOf = (ratings: Ratings, voter: number, shares: Record<string, number>) =>
  sum(optionsOf(ratings).map((option) => shares[option] * ratings[option][voter]))

/** The product of every voter's satisfaction under `shares`. */
const productOf = (ratings: Ratings, shares: Record<string, number>) =>
  votersOf(ratings).reduce((product, voter) => product * satisfactionOf(ratings, voter, shares), 1)

/** A number as the satisfaction working writes it: to two decimal places at most. */
const decimal = (n: number) => Math.round(n * 100) / 100

/** A worked figure in a table, to two decimal places at most, written as a number even where whole. */
function figure(n: number): Cell {
  return { emoji: decimal(n), said: String(decimal(n)), figure: true }
}

/**
 * The fractional-winners result: the ratings as they were given, with each
 * option's share, in the whole percentages the page prints, as its total.
 */
function shareRows(ratings: Ratings, percent: Record<string, number>): Row[] {
  return ratingRows(ratings).map((row) => ({ ...row, total: `${percent[row.name]}%` }))
}

/**
 * The fractional-winners working: each star times its option's share, then a
 * row of each voter's satisfaction (the column above it added up), whose
 * total alone is filled in: every satisfaction multiplied together. Worked
 * from the printed percentages, so a reader can redo it by hand.
 */
function satisfactionRows(ratings: Ratings, percent: Record<string, number>): Row[] {
  const fractions = Object.fromEntries(optionsOf(ratings).map((o) => [o, percent[o] / 100]))
  const options = optionsOf(ratings).map((name) => ({
    name,
    cells: ratings[name].map((score) => figure(score * fractions[name])),
  }))
  return [
    ...options,
    {
      name: 'satisfaction',
      heading: { emoji: '➕', said: 'Satisfaction, the column added up' },
      cells: votersOf(ratings).map((voter) => figure(satisfactionOf(ratings, voter, fractions))),
      total: Math.round(productOf(ratings, fractions)),
    },
  ]
}

/**
 * Consensus option's working: the ratings, with each option's lowest score
 * marked and given as its total, the highest of those marked the winner.
 * Neither example ties on a floor.
 */
function floorRows(ratings: Ratings): Row[] {
  return withWinner(
    optionsOf(ratings).map((name) => {
      const floor = Math.min(...ratings[name])
      return {
        name,
        cells: ratings[name].map((score) => ({
          ...keycap(score),
          marked: score === floor,
          said: score === floor ? `${score}, the fewest` : String(score),
        })),
        total: floor,
      }
    }),
  )
}

/**
 * Every set of `size` options, best first by consensus winners' rules: each
 * voter served by their favorite in the set, sets compared on the
 * worst-served voter, then the next (leximin), then on total stars.
 * `56_consensus_winners` counts the same dinner.
 */
function consensusSetsOf(ratings: Ratings, size: number) {
  const options = optionsOf(ratings)
  const sets: string[][] = []
  const grow = (from: number, set: string[]) => {
    if (set.length === size) return void sets.push(set)
    for (let i = from; i < options.length; i++) grow(i + 1, [...set, options[i]])
  }
  grow(0, [])
  const judged = sets.map((names) => ({
    names,
    served: votersOf(ratings).map((voter) => Math.max(...names.map((n) => ratings[n][voter]))),
    stars: sum(names.flatMap((n) => ratings[n])),
  }))
  const ladder = (served: number[]) => [...served].sort((a, b) => a - b)
  return judged.sort((a, b) => {
    const [x, y] = [ladder(a.served), ladder(b.served)]
    const at = x.findIndex((v, i) => v !== y[i])
    return at >= 0 ? y[at] - x[at] : b.stars - a.stars
  })
}

/** The ratings of `names`, each voter's favorite among them circled. */
function servedRows(ratings: Ratings, names: string[]): Row[] {
  return names.map((name) => ({
    name,
    cells: ratings[name].map((score, voter) => {
      const best = Math.max(...names.map((n) => ratings[n][voter]))
      return {
        ...keycap(score),
        marked: score === best,
        said: score === best ? `${score}, their favorite of these` : String(score),
      }
    }),
  }))
}

/**
 * `DINNER` with a seventh friend, who joins the sequential polls' last week.
 * They love tacos, which hands that week to tacos, so every restaurant gets a
 * turn across the four weeks, and pizza, winning weeks 1 and 3, shows that an
 * option can win again.
 */
const WITH_LATECOMER: Ratings = {
  pizza: [...DINNER.pizza, 0],
  tacos: [...DINNER.tacos, 5],
  sushi: [...DINNER.sushi, 3],
}

/** One poll of a run of sequential polls. */
interface Week {
  /**
   * Each voter's strength going in, as the page writes it: an exact fraction
   * where it comes from the stars they gave earlier winners, two decimals
   * where it is an average (a voter who joined late).
   */
  strengths: string[]
  winner: string
}

/**
 * Sequential polls: Multiple winners spread across polls, so every option is
 * on every poll, an earlier winner included, and each ballot counts at the
 * strength the winners before it leave it (`weightOf`). A poll may have more
 * voters than the one before (the extra columns of `ratings`); each newcomer
 * starts at the average strength of the voters already there, and is charged
 * from then on as though they had given the stars that would leave them at it.
 */
function weeksOf(polls: Ratings[]): Week[] {
  let given: number[] = []
  return polls.map((ratings) => {
    const average = given.length ? sum(given.map(weightOf)) / given.length : 1
    const weights = votersOf(ratings).map((voter) =>
      voter < given.length ? weightOf(given[voter]) : average,
    )
    const strengths = votersOf(ratings).map((voter) =>
      weights[voter] === 1
        ? '1/1'
        : voter < given.length && Number.isInteger(given[voter])
          ? fractionOf(given[voter])
          : String(decimal(weights[voter])),
    )
    const total = (option: string) => weightedTotal(ratings, option, weights)
    const finalists = optionsOf(ratings)
      .sort((x, y) => total(y) - total(x))
      .slice(0, 2)
    const winner = runoffWinner(ratings, finalists, weights)
    // A newcomer is charged the stars that would have left them at the
    // average, from 5 ÷ (5 + given).
    given = votersOf(ratings).map(
      (voter) =>
        (voter < given.length ? given[voter] : MAX_STARS / average - MAX_STARS) +
        ratings[winner][voter],
    )
    return { strengths, winner }
  })
}

/**
 * One row per week: the week's winner as its heading, each ballot's strength
 * in its cells, and a gap for a voter who had not joined yet.
 */
function weekRows(weeks: Week[]): Row[] {
  const voters = Math.max(...weeks.map((week) => week.strengths.length))
  return weeks.map((week, i) => ({
    name: `week-${i + 1}`,
    heading: { emoji: ICONS[week.winner], said: `Week ${i + 1}, won by ${week.winner}` },
    cells: Array.from({ length: voters }, (_, voter): Cell => {
      const strength = week.strengths[voter]
      if (strength === undefined) return blank('not joined yet')
      if (strength === '1/1') return keycap(1)
      return { emoji: strength, said: strength, figure: true }
    }),
  }))
}

/** The winner of each sequential poll, in order, as `Places` draws a ranking. */
function Weeks({ weeks }: { weeks: Week[] }) {
  return (
    <Group component="ol" justify="center" gap="lg" className={classes.places}>
      {weeks.map((week, i) => (
        <Text component="li" key={i} fw={700}>
          Week {i + 1}:{' '}
          <span aria-hidden className={classes.emoji}>
            {ICONS[week.winner]}
          </span>{' '}
          {labelOf(week.winner)}
        </Text>
      ))}
    </Group>
  )
}

/**
 * Options already placed or chosen, drawn faded with their trophy and nothing
 * else. `ratings` keeps their stars on show instead of blanks, where those
 * stars are what the next round turns on: the ballots before the
 * multiple-winner reweighting, whose weights come from them.
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
  /** Circled, as the cell the row turns on (an option's fewest stars). */
  marked?: boolean
}

interface Row {
  name: string
  /** What the row heading draws instead of the option's emoji, for a row that is not an option. */
  heading?: { emoji: string; said: string }
  cells: Cell[]
  /** A number, or a figure already written out (a share). Only a number can win. */
  total?: number | string
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
  const best = Math.max(...rows.map((r) => (typeof r.total === 'number' ? r.total : -1)))
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
                {row.heading ? (
                  <>
                    <span aria-hidden className={classes.emoji}>
                      {row.heading.emoji}
                    </span>
                    <VisuallyHidden>{row.heading.said}</VisuallyHidden>
                  </>
                ) : (
                  <OptionIcon name={row.name} />
                )}
              </th>
              {row.cells.map((cell, voter) => (
                <td
                  key={voter}
                  className={
                    [cell.figure && classes.figure, cell.marked && classes.marked]
                      .filter(Boolean)
                      .join(' ') || undefined
                  }
                >
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

/** The options given a share, largest first, ties in the page's own order. */
const sharesInOrder = (percent: Record<string, number>) =>
  Object.keys(percent)
    .filter((option) => percent[option] > 0)
    .sort((x, y) => percent[y] - percent[x])

/** Fractional winners' answer, drawn as `Places` draws a ranking, with each share. */
function Shares({ percent }: { percent: Record<string, number> }) {
  return (
    <Group component="ul" justify="center" gap="lg" className={classes.places}>
      {sharesInOrder(percent).map((option) => (
        <Text component="li" key={option} fw={700}>
          <span aria-hidden className={classes.emoji}>
            {ICONS[option]}
          </span>{' '}
          {labelOf(option)} {percent[option]}%
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
