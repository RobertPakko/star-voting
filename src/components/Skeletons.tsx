import { Fragment, type ReactNode } from 'react'
import {
  Box,
  Card,
  Divider,
  Group,
  SimpleGrid,
  Skeleton,
  Stack,
  VisuallyHidden,
} from '@mantine/core'
import { RESULTS_ROWS_MAX } from '../lib/resultsRows'
import { isDaily, toMinutes } from '../lib/schedule'
import type { PollSchedule } from '../lib/types'

/**
 * The shapes each page draws while it is waiting for its first read.
 *
 * Four rules keep them honest:
 *
 *  - **A skeleton claims only what the page always has.** The poll list draws
 *    five cards because the wait is over long before anyone counts them; it
 *    does not draw a description, which most polls do not have. A placeholder
 *    for something that then fails to appear is a small lie the reader has to
 *    un-learn. The other side of it is that a shape claims everything the page
 *    *does* always have — and a condition in the source is not the same thing
 *    as a case that happens; see AGENTS.md for the runoff card, which was left
 *    out for years on the strength of one.
 *  - **A shape only exists for a wait that exists.** A card that guesses at
 *    nothing is a card whose content the page already has, and once
 *    `poll_page` carried the roster that was true of `RosterSkeleton`, which
 *    is why there is no longer one. The test is whether the card is still
 *    reachable holding nothing: `ResultsSkeleton` and `BallotsSkeleton` are,
 *    because the live tick carries no tally and a crossing between two
 *    questions of an open poll re-reads through `open_poll_view`.
 *  - **They are one component per page, next to nothing else.** Every skeleton
 *    in the app is in this file, so a page and its stand-in are changed
 *    together rather than drifting apart; the failure mode of skeletons is
 *    that they slowly stop resembling anything.
 *  - **They are built out of the containers the page is built out of.** The
 *    same `maw`, the same `gap`, the same cards in the same order, so the
 *    shapes stand where the content lands and the swap is a fill rather than a
 *    jump. Anything the pages share a component for — the heading over a poll,
 *    the card a question is answered in — is one shape here too, for the
 *    reason PollHeading and BallotCard are one component each: three copies
 *    are three things to keep in step.
 *
 * The one place this file departs from what the page does is the bars: a bar
 * is drawn a little shorter than the line of text it stands in for, because a
 * block the full height of a line reads as a filled row rather than as a gap
 * waiting to be filled. **The line itself is not shortened**: every bar sits
 * centred in a box the height of the line it replaces (`Bar`), so the text
 * lands where its bar was. Drawn bare, each bar was a few pixels short of its
 * line, and those pixels added up down a page — a ten-option score round
 * stood eighty pixels shorter than the tally that replaced it. `text` below is
 * that mapping, in one place.
 *
 * Screen readers get none of it: the shapes are decoration, and what a
 * non-visual reader needs is the one word the shapes are miming.
 */
function Loading({ children }: { children: ReactNode }) {
  return (
    <div role="status" aria-busy="true">
      <VisuallyHidden>Loading…</VisuallyHidden>
      <div aria-hidden>{children}</div>
    </div>
  )
}

/**
 * A kind of line the app writes, named for the text it stands in for: the
 * height Mantine gives that line (its font size times its line height), and
 * the bar drawn inside it.
 */
const text = {
  /** `Title order={1}`: the About page's heading. */
  page: { line: 44, bar: 34 },
  /** `Title order={2}`: a poll's own title, and the heading over the list. */
  title: { line: 35, bar: 28 },
  /** `Title order={4}`: the heading over a card. */
  heading: { line: 26, bar: 20 },
  /** `Text size="lg"`: the banner naming a winner. */
  banner: { line: 29, bar: 22 },
  /** `Text` at its default size: an option's name, a poll's on a list card. */
  name: { line: 25, bar: 16 },
  /** `Text size="sm"`: the sentences beside and under everything. */
  line: { line: 20, bar: 12 },
  /** `Text size="xs"`: who created the poll, and the notes in the form. */
  note: { line: 17, bar: 10 },
} as const

/**
 * One line of text: a bar centred in a box the line's own height. `grow` is
 * for a line sharing a row with something pinned to the far end, where the box
 * has to take the slack for a percentage width to mean anything.
 */
function Bar({
  kind,
  width,
  grow = false,
}: {
  kind: keyof typeof text
  width?: number | string
  grow?: boolean
}) {
  return (
    <Box
      h={text[kind].line}
      style={{
        display: 'flex',
        alignItems: 'center',
        ...(grow ? { flex: 1, minWidth: 0 } : { flex: 'none' }),
      }}
    >
      <Skeleton height={text[kind].bar} width={width} maw="100%" radius="sm" />
    </Box>
  )
}

/** A badge, at the height Mantine draws one. */
const badge = 20

/** A button or an input, likewise. Both are 36 at the size the app uses. */
const control = 36

/** A subtle `ActionIcon`: an 18px glyph in a 28px target. */
function IconShape() {
  return (
    <Box p={5} style={{ flex: 'none' }}>
      <Skeleton height={18} width={18} radius="sm" />
    </Box>
  )
}

/**
 * The most option rows a ballot's shape will draw. The ballot itself draws
 * every option, so this is the one place the shape is deliberately shorter
 * than what arrives — and it has to be, because of what a crossing is told. The
 * strip carries an `option_count` per question and not what kind of question
 * it is, so a crossing onto a calendar holding a hundred windows would
 * otherwise put up a hundred rows of stars for a card five hundred pixels tall.
 * Ten rows is about that tall, and short is the safe direction.
 */
const BALLOT_ROWS_MAX = 10

/**
 * The heading every screen puts a poll under: its title with the state badge
 * beside it, and the row of four tags saying what kind of poll it is. See
 * PollHeading, whose shape this is, `compact` included.
 *
 * The description is left out on purpose — it is optional and most polls have
 * none. The creator line is always drawn because every heading names who
 * created the poll.
 */
function PollHeadingShape({ compact = false }: { compact?: boolean }) {
  return (
    <Stack gap="xs">
      <Stack gap={2}>
        <Group align="flex-start" gap="sm" wrap="nowrap">
          <Bar kind={compact ? 'name' : 'title'} width="70%" grow />
          <Skeleton
            height={badge}
            width={compact ? 88 : 104}
            radius="xl"
            style={{ flex: 'none' }}
          />
        </Group>
        <Bar kind="note" width={96} />
      </Stack>
      {/* Invite only / voters shown / ballots published / how many have
          answered: four badges, always, in that order. See PollTags. */}
      <Group gap="xs">
        {[86, 96, 118, 74].map((w, i) => (
          <Skeleton key={i} height={badge} width={w} radius="xl" />
        ))}
      </Group>
    </Stack>
  )
}

/**
 * The five stars an option is scored with: a 20px star in a button padded
 * 6px by 3px, which is what makes the row 32px tall. See StarRating.
 */
function StarsShape() {
  return (
    <Group gap={0} wrap="nowrap" style={{ flex: 'none' }}>
      {Array.from({ length: 5 }, (_, i) => (
        <Box key={i} py={6} px={3}>
          <Skeleton height={20} width={20} radius="sm" />
        </Box>
      ))}
    </Group>
  )
}

/**
 * What fills the card a question is answered in: a row per option with its
 * stars, ruled off from the next, and the footer saying when the results come
 * out beside the button that sends the ballot.
 *
 * **One card, not a card per option.** The ballot was a stack of cards once
 * and this stood in for that stack long after it had become the single
 * `BallotCard` both readings of a poll now put up. It is also the shape of
 * every other card that can be in that slot — the option list still being
 * collected, and the card a voter who has already answered comes back to —
 * because those are the same card with different rows in it.
 *
 * The card itself is the caller's, because one of the two callers has real
 * things to put in it beside these shapes; see `QuestionSkeleton`.
 *
 * **A list still being collected is drawn as one.** It has no stars and no
 * line telling the reader how to score — its rows are an option's name with
 * the rule under it, and its foot is two buttons, *Add option* and whichever
 * press ends the card. Which stage the poll is at is one fact for the whole
 * group (`finalize_options` opens every question at once), so a crossing
 * between two questions always knows it.
 */
function BallotShape({ rows, collecting = false }: { rows: number; collecting?: boolean }) {
  const shown = Math.min(rows, BALLOT_ROWS_MAX)

  if (collecting) {
    return (
      <Stack gap="sm">
        {Array.from({ length: shown }, (_, i) => (
          <Stack key={i} gap={0} h={41} justify="space-between">
            <Bar kind="name" width="45%" />
            <Divider />
          </Stack>
        ))}
        <FooterShape buttons={[112, 144]} />
      </Stack>
    )
  }

  return (
    <Stack gap="sm">
      {/* How to score, over the list: one line in the card BallotCard puts
          up on every poll. */}
      <Bar kind="line" width={480} />
      <Divider />
      {Array.from({ length: shown }, (_, i) => (
        <Fragment key={i}>
          <Group justify="space-between" wrap="nowrap" gap="sm">
            <Bar kind="name" width="45%" grow />
            <StarsShape />
          </Group>
          <Divider />
        </Fragment>
      ))}
      <FooterShape buttons={[112]} />
    </Stack>
  )
}

/**
 * The foot of every card a question is answered in: two lines of what happens
 * next — when the results unlock and that the vote can be changed until they
 * do, or when voting opens — beside the buttons that end the card. See
 * RevealNote and BallotFrame.
 */
function FooterShape({ buttons }: { buttons: number[] }) {
  return (
    <Group justify="space-between" wrap="wrap" gap="sm">
      <Stack gap={0} maw="100%">
        <Bar kind="line" width={320} />
        <Bar kind="line" width={232} />
      </Stack>
      <Group gap="sm" style={{ marginLeft: 'auto' }}>
        {buttons.map((w, i) => (
          <Skeleton key={i} height={control} width={w} radius="md" />
        ))}
      </Group>
    </Group>
  )
}

/**
 * What fills the card of a question that is a calendar: the line telling the
 * reader how to paint, the offset beside the brush, the header that walks the
 * calendar and switches its view, and the grid. See TimeBallotCard and
 * PaintCalendar.
 *
 * The grid's height is the one thing worth working out, because it is most of
 * the card: a week is a 58px row of day headings over 40px an hour, between
 * the times the poll's `window` names; a poll answered in whole days opens on
 * the month instead, which is a row of weekday names over five weeks. The
 * window is the axis the poll was created with, and a poll that collected its
 * times can have widened it since (see `axisFor`), so on that poll this is a
 * little short — the safe direction.
 */
function CalendarShape({ schedule }: { schedule: PollSchedule }) {
  const grid = isDaily(schedule)
    ? 536
    : 58 +
      Math.max(1, (toMinutes(schedule.window.end) - toMinutes(schedule.window.start)) / 60) * 40

  return (
    <Stack gap="sm">
      <Stack gap="xs">
        <Bar kind="line" width={420} />
        <Group justify="space-between" wrap="wrap" gap="sm">
          <Bar kind="note" width={340} />
          <Skeleton height={31} width={214} radius="md" />
        </Group>
        <Group justify="space-between" wrap="nowrap" gap="sm">
          <Group gap={8} wrap="nowrap">
            <Skeleton height={32} width={32} radius="md" />
            <Skeleton height={32} width={190} radius="md" />
            <Skeleton height={32} width={32} radius="md" />
          </Group>
          <Skeleton height={32} width={189} radius="md" />
        </Group>
        <Skeleton height={grid} mt={8} radius="md" />
      </Stack>
      <FooterShape buttons={[112]} />
    </Stack>
  )
}

/**
 * A card with one line in it: the banner naming a question's winner, and the
 * notice a question nobody answered puts up in its place. One shape, because
 * a finished question always has exactly one of the two and they are the same
 * card — see `TallyShape`, which draws the rounds under this, and
 * `QuestionSkeleton`, which draws this alone on the crossings where which of
 * the two is coming is not yet knowable.
 */
function BannerShape() {
  return (
    <Card withBorder>
      <Bar kind="banner" width="60%" />
    </Card>
  )
}

/**
 * A finished question's tally: the banner naming the winner, the score round,
 * and the automatic runoff that settled it. What `Results` draws, down to the
 * order and the gaps, minus the two parts of it that are conditional.
 *
 * **All three cards, because a tally has all three.** The runoff used to be
 * left out on the grounds that it is written behind a condition —
 * `results.runoff && results.finalists.length === 2` — but that condition
 * cannot fail on a poll that has a tally at all: every question is held to at
 * least two options (`finalize_options` refuses to open one that is short,
 * and the create form refuses to send it), so `star_round` always fills both
 * finalist slots and always runs the runoff between them. The pool of one
 * that the `is distinct from 2` branch in that function guards against is
 * reachable only from the ranking, which walks down to a last option
 * standing. So a card that always arrives now has a shape that always waits
 * for it, rather than a page that grew by a third after the wait was over.
 *
 * The one left out is genuinely conditional and stays that way: the
 * tie-breaks, which most polls do not have. The full ranking's button is drawn
 * wherever the option count is known, since it is drawn from three options up
 * (see FullRanking) and so is certain given the count; with no count there is
 * nothing to decide it from.
 */
function TallyShape({ options }: { options?: number }) {
  // The same ceiling the score round itself draws to, so a schedule poll's
  // hundred windows do not put up a page of bars for a card that arrives
  // twenty rows long. A shape taller than the thing it is waiting for is the
  // lie this file's own note warns about, and at that length it is the whole
  // page rather than a row of it. See resultsRows.ts.
  const rows = Math.min(options ?? 5, RESULTS_ROWS_MAX)

  return (
    <Stack gap="md">
      <BannerShape />

      <Stack gap={2}>
        <Bar kind="heading" width={112} />
        <Card withBorder p="sm">
          <Stack gap="xs">
            {Array.from({ length: rows }, (_, i) => (
              <div key={i}>
                <Group justify="space-between" mb={2} wrap="nowrap" gap="xs">
                  <Bar kind="line" width="35%" grow />
                  <Bar kind="line" width={104} />
                </Group>
                {/* A Progress bar, at the height and radius Mantine draws
                    one; the one shape here that is not a line of text. */}
                <Skeleton height={8} radius="md" />
              </div>
            ))}
            {/* Past the ceiling the score round says how many it left out,
                which is certain from the count alone. */}
            {options !== undefined && options > RESULTS_ROWS_MAX && <Bar kind="line" width="75%" />}
          </Stack>
        </Card>
      </Stack>

      {/* The runoff: the two finalists with what each was preferred by, and
          the line counting the ballots that split them evenly. Three lines
          and no more — the sentences under them explain a runoff that tied,
          which is the rare ending rather than the ordinary one. */}
      <Stack gap={2}>
        <Bar kind="heading" width={192} />
        <Card withBorder p="sm">
          <Stack gap="xs">
            {/* The finalists are named, so those two are a proportion; the
                line under them is the same sentence on every poll. */}
            <Bar kind="line" width="48%" />
            <Bar kind="line" width="44%" />
            <Bar kind="line" width={216} />
          </Stack>
        </Card>
      </Stack>

      {/* The rule with *See the full ranking* on it; see FullRanking. */}
      {options !== undefined && options >= 3 && (
        <Divider labelPosition="center" label={<Skeleton height={26} width={141} radius="sm" />} />
      )}
    </Stack>
  )
}

/** The heading over a poll and the card answering it: every poll page. */
export function PollPageSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <Loading>
      <Stack maw={720} mx="auto" gap="md">
        <PollHeadingShape />
        <Card withBorder>
          <BallotShape rows={rows} />
        </Card>
      </Stack>
    </Loading>
  )
}

/**
 * One question of a poll, while the poll around it stays on screen.
 *
 * The only stand-in here for part of a page rather than a whole one, and the
 * reason is that the pages of a multi-question poll are mostly the same page.
 * The heading and the poll's terms belong to the poll rather than to the
 * question, so they are already right for the question being opened and stay
 * where they are; this fills the hole underneath them while that question's
 * own ballot is read. Crossing between two questions would otherwise blink the
 * whole poll away and back.
 *
 * **The two things inside the card that are not the question's are handed in
 * and drawn for real**: the strip of questions, and the name box on an open
 * poll that shows its respondents. Both belong to the poll's half of the page
 * like the heading does, and only happen to live inside the card a crossing
 * replaces. Stood in for, the strip greyed out at the exact moment a reader
 * was using it to navigate — putting the way out of the question behind the
 * wait — and the name box took what had been typed into it with it.
 *
 * They therefore sit outside the `Loading` wrapper, which hides what it holds
 * from screen readers. A real link or a real input in there would be one
 * nothing could reach: announced to nobody and still in the tab order.
 */
export function QuestionSkeleton({
  rows,
  finished = false,
  tallied = false,
  collecting = false,
  schedule,
  nameField,
  strip,
}: {
  /**
   * How many options the question being opened holds, which is a row on its
   * ballot and a bar in its score round alike. The invite reading knows it
   * before the read lands — the strip carries an `option_count` per question
   * — and the share-link reading does not; see `open_poll_group` for why that
   * list is the bare one.
   */
  rows?: number
  /**
   * Whether the poll has stopped taking answers, which moves the strip out of
   * the card: a question still being answered is one card with the strip
   * inside it, and a question that is over is the strip and then a block —
   * the tally, or the notice a question nobody answered puts up. The pages
   * place the real strip on exactly this fact, so the stand-in has to as
   * well, or a crossing between two finished questions boxes the strip up for
   * as long as the read takes and lets it out again.
   */
  finished?: boolean
  /**
   * Whether the question being opened is certain to have a tally under the
   * strip rather than the notice a question nobody answered puts up, which
   * decides how much of the block below is claimed.
   *
   * The fact behind it is `results_available && !is_closed`, read off the
   * question being *left*. It carries because results need every question in
   * the group gated open, and `poll_gate_open` opens on one of two things: the
   * poll was closed, or every invitee answered that question. Closing is one
   * act over the whole group, so results out with no `closed_at` means every
   * question was answered by everyone invited — including the one being
   * opened, which therefore has a tally coming.
   *
   * A poll closed early is the case this is false for, and false honestly:
   * closing settles the group at whatever it had. An open poll is always in
   * that case, its questions having no invite list to have finished, which is
   * why the share-link reading keeps the one card it always drew.
   */
  tallied?: boolean
  /**
   * Whether the poll is still collecting its options, which makes the card a
   * list rather than a ballot; see `BallotShape`.
   */
  collecting?: boolean
  /**
   * The schedule of a question known to be a calendar — which only the time
   * ballot's own wait for its chunk is, since a crossing is not told what kind
   * of question it is crossing to. See `CalendarShape`.
   */
  schedule?: PollSchedule
  /** The name box, on the polls that ask for one; see VoterNameField. */
  nameField?: ReactNode
  /** The way between the poll's questions; see QuestionStrip. */
  strip?: ReactNode
}) {
  // Under the strip, as much of the ending as is known to be coming. Where a
  // tally is certain that is the whole of it — the same three cards `Results`
  // puts up a beat later and then fills, rather than one card that becomes
  // four. Where it is not, this is still the one card both endings share, and
  // `ResultsSkeleton`'s first shape is this one, so the wait continues rather
  // than starting over. A finished question asks for no name.
  if (finished) {
    return (
      <>
        {strip}
        <Loading>{tallied ? <TallyShape options={rows} /> : <BannerShape />}</Loading>
      </>
    )
  }

  return (
    <Card withBorder>
      <Stack gap="sm">
        {nameField}
        {strip}
        <Loading>
          {schedule ? (
            <CalendarShape schedule={schedule} />
          ) : (
            <BallotShape rows={rows ?? 5} collecting={collecting} />
          )}
        </Loading>
      </Stack>
    </Card>
  )
}

/**
 * The poll list: its heading, its button, and a page of cards.
 *
 * Five cards where a page holds ten, because five is what fills the first
 * screen and nobody counts the ones below it before the wait is over.
 */
export function PollListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <Loading>
      <Stack maw={720} mx="auto" gap="md">
        <Group justify="space-between">
          <Bar kind="title" width={124} />
          <Skeleton height={control} width={96} radius="md" />
        </Group>
        <Stack gap="md">
          {Array.from({ length: rows }, (_, i) => (
            <Card withBorder key={i}>
              {/* The same heading the poll's own page carries, at card size,
                  because the card is that heading — and the eye that hides
                  it from the list, at the foot of the row beside it. */}
              <Group align="flex-end" wrap="nowrap" gap="xs">
                <Box style={{ flex: 1, minWidth: 0 }}>
                  <PollHeadingShape compact />
                </Box>
                <IconShape />
              </Group>
            </Card>
          ))}
        </Stack>
      </Stack>
    </Loading>
  )
}

/**
 * The tally, while `Results` reads it: the winner, the score round and the
 * runoff. See `TallyShape`, which is the same three cards `QuestionSkeleton`
 * puts up a beat earlier on the crossings that can be sure of them, so the
 * two stages of that wait are one shape standing still rather than a page
 * that fills in twice.
 */
export function ResultsSkeleton({ options }: { options?: number }) {
  return (
    <Loading>
      <TallyShape options={options} />
    </Loading>
  )
}

/**
 * The full ranking, while the modal waits for it: a place number, the option
 * on it with what it scored, and the line saying how the place was settled.
 *
 * `places` is the poll's option count, which is the number of places on every
 * poll that did not end in a tie -- and a tie for a place is rare enough that
 * drawing for it would be the lie the note at the top of this file warns
 * about, one place too few rather than one too many.
 */
export function RankingSkeleton({ places = 5 }: { places?: number }) {
  return (
    <Loading>
      <Stack gap="md">
        {Array.from({ length: places }, (_, i) => (
          <Group key={i} align="flex-start" wrap="nowrap" gap="sm">
            <Skeleton height={26} width={34} radius="xl" style={{ flex: 'none' }} />
            <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
              <Group gap="xs" wrap="nowrap">
                <Bar kind="name" width={160} />
                <Bar kind="line" width={44} />
              </Group>
              <Bar kind="line" width="70%" />
            </Stack>
          </Group>
        ))}
      </Stack>
    </Loading>
  )
}

/**
 * The published ballot grid: a heading, and a bordered table with a row per
 * ballot and a total under them.
 *
 * The rows are drawn whole rather than split into cells. The grid is as wide
 * as the poll has options, this is drawn before anything has said how many
 * there are, and a column count guessed here would be a column count wrong on
 * most polls — so it claims a table with a header, some ballots and a total,
 * which every one of them has.
 */
export function BallotsSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <Loading>
      <Stack gap={2}>
        {/* The heading and the download beside it, which is there on every
            sheet with a ballot on it. */}
        <Group justify="space-between" wrap="nowrap" align="center" gap="xs">
          <Bar kind="heading" width={76} />
          <IconShape />
        </Group>
        {/* The border and the rules are the table's own; the cells inside them
            are one bar per row, in a box the height a table row is drawn at. */}
        <Card withBorder p={0} radius="sm">
          <Stack gap={0}>
            <TableRowShape width="45%" />
            <Divider />
            {Array.from({ length: rows }, (_, i) => (
              <Fragment key={i}>
                <TableRowShape />
                <Divider />
              </Fragment>
            ))}
            <TableRowShape width="30%" />
          </Stack>
        </Card>
      </Stack>
    </Loading>
  )
}

/** One row of a `Table`: a line of text with 7px of cell padding over and under. */
function TableRowShape({ width }: { width?: string }) {
  return (
    <Box px="xs" h={36} style={{ display: 'flex', alignItems: 'center' }}>
      <Skeleton height={text.line.bar} width={width} radius="sm" />
    </Box>
  )
}

/**
 * The reader's own ballot, while `YourBallot` reads it: a heading, and a card
 * with a row per option -- the name, and the five stars it was scored on.
 *
 * The star row is claimed exactly rather than guessed at, unlike anything in
 * the published grid beside it: a ballot is five stars wide whatever the poll
 * is about. What is guessed at is how many rows, and the caller knows -- the
 * page holds the option list long before it holds the ballot scored against
 * it.
 *
 * Capped at the score round's ceiling, which is the one place this shape is
 * deliberately *shorter* than what arrives: the card itself draws every option,
 * because a reader who came to see what they scored came to see all of it, and
 * a time poll's hundred windows would otherwise be a page of bars waiting on a
 * card. Short is the safe direction -- the page grows into it rather than
 * losing a row that was promised. See resultsRows.ts and TallyShape.
 */
export function YourBallotSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <Loading>
      <Stack gap={2}>
        <Bar kind="heading" width={84} />
        <Card withBorder p="sm">
          <Stack gap="xs">
            {Array.from({ length: Math.min(rows, RESULTS_ROWS_MAX) }, (_, i) => (
              <Group key={i} justify="space-between" wrap="nowrap" gap="sm">
                <Bar kind="line" width="40%" grow />
                {/* Five 18px stars with 2px between them, which is what the
                    row beside the name actually is. */}
                <Skeleton height={18} width={98} radius="sm" />
              </Group>
            ))}
          </Stack>
        </Card>
      </Stack>
    </Loading>
  )
}

/** A heading and what the create form stacks under it: a field, or a card. */
function FieldShape({ label, children }: { label: number; children: ReactNode }) {
  return (
    <Stack gap={2}>
      <Bar kind="heading" width={label} />
      {children}
    </Stack>
  )
}

/**
 * The About page, which is fetched rather than bundled — see the `lazy` calls
 * in App.tsx — so it has a wait of its own now.
 *
 * The heading, the paragraph under it, the row of three sample cards and the
 * tab strip: everything above the fold and everything that is there whichever
 * tab opens. Nothing of the panel below the strip, because which panel that
 * is depends on the tab and all three are different lengths.
 */
export function AboutSkeleton() {
  return (
    <Loading>
      <Stack maw={720} mx="auto" gap="md">
        <Bar kind="page" width={96} />

        <Stack gap={0}>
          {['100%', '100%', '72%'].map((w, i) => (
            <Bar key={i} kind="name" width={w} />
          ))}
        </Stack>

        {/* See `SampleCard` in About.tsx: the icon, a title over two lines
            of description, and a button the width of the card, pushed to its
            foot. */}
        <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="md">
          {Array.from({ length: 3 }, (_, i) => (
            <Card key={i} withBorder radius="md" p="lg">
              <Stack gap="sm">
                <Skeleton height={42} width={42} radius="md" />
                <Stack gap={4}>
                  <Bar kind="name" width="70%" />
                  <Stack gap={0}>
                    <Bar kind="line" width="95%" />
                    <Bar kind="line" width="60%" />
                  </Stack>
                </Stack>
                <Skeleton height={control} mt="xs" radius="md" />
              </Stack>
            </Card>
          ))}
        </SimpleGrid>

        {/* `Tabs.List grow`: three tabs sharing the width, over the rule they
            sit on. */}
        <Stack gap={0}>
          <Group gap={0} wrap="nowrap">
            {Array.from({ length: 3 }, (_, i) => (
              <Box key={i} style={{ flex: 1, padding: '10px 16px' }}>
                <Skeleton height={text.name.bar} radius="sm" />
              </Box>
            ))}
          </Group>
          <Skeleton height={1} radius={0} />
        </Stack>
      </Stack>
    </Loading>
  )
}

/**
 * The create form while it waits: for its own chunk, which is fetched rather
 * than bundled (see the `lazy` calls in App.tsx), and for the poll it is being
 * prefilled from when that poll is being duplicated. Its centred title, its
 * five labelled sections, and the button that creates the poll.
 *
 * The three cards are drawn as cards because that is what they are — who may
 * vote, what the poll shows, and the options themselves each sit in one. What
 * is inside them is the form a new poll opens on, which is the one the chunk's
 * wait is always followed by: an invite list, and a list of options. A
 * duplicate of an open poll or a time poll puts up something else in two of
 * those cards, and which it is is not known until the poll it is copied from
 * lands.
 */
export function FormSkeleton() {
  return (
    <Loading>
      <Stack maw={720} mx="auto" gap="md">
        <Group justify="center">
          <Bar kind="title" width={120} />
        </Group>

        <FieldShape label={44}>
          <Skeleton height={control} radius="md" />
        </FieldShape>

        <FieldShape label={92}>
          {/* A textarea of two rows, which is what the description opens at. */}
          <Skeleton height={57} radius="md" />
        </FieldShape>

        {/* Invited people or anyone with the link; the note over the box
            invitees are typed into, the box, and the checkbox adding the
            creator to the list. */}
        <FieldShape label={62}>
          <Card withBorder p="sm">
            <Stack gap="xs">
              <Skeleton height={control} radius="md" />
              <Stack gap={2}>
                <Bar kind="note" width="55%" />
                <Skeleton height={control} radius="md" />
              </Stack>
              <Group gap="sm" wrap="nowrap">
                <Skeleton height={20} width={20} radius="sm" />
                <Bar kind="line" width={280} />
              </Group>
            </Stack>
          </Card>
        </FieldShape>

        <FieldShape label={112}>
          <Card withBorder p="sm">
            <Stack gap="sm">
              {[132, 108, 176, 140].map((w, i) => (
                <Group key={i} gap="sm" wrap="nowrap">
                  <Skeleton height={badge} width={38} radius="xl" />
                  <Bar kind="line" width={w} />
                </Group>
              ))}
            </Stack>
          </Card>
        </FieldShape>

        {/* Choose an option or find a time, and then the options: the note
            about descriptions, two rows, and the button adding a third. */}
        <FieldShape label={68}>
          <Card withBorder p="sm">
            <Stack gap="xs">
              <Skeleton height={control} radius="md" />
              <Bar kind="note" width="40%" />
              {Array.from({ length: 2 }, (_, i) => (
                <Group key={i} gap="xs" wrap="nowrap">
                  <Skeleton height={control} radius="md" style={{ flex: 1 }} />
                  <Skeleton height={28} width={28} radius="md" />
                  <Skeleton height={28} width={28} radius="md" />
                </Group>
              ))}
              <Skeleton height={30} width={92} radius="md" />
            </Stack>
          </Card>
        </FieldShape>

        <Group justify="flex-end">
          <Skeleton height={control} width={108} radius="md" />
        </Group>
      </Stack>
    </Loading>
  )
}
