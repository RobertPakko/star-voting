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

/**
 * The shapes each page draws while it is waiting for its first read.
 *
 * Four rules keep them honest:
 *
 *  - **A skeleton claims only what the page always has.** The poll list draws
 *    three cards because the wait is over long before anyone counts them; it
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
 * waiting to be filled. `bar` below is that mapping, in one place.
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

/** A bar per kind of line the app writes, named for the text it stands in for. */
const bar = {
  /** `Title order={2}`: a poll's own title, and the heading over the list. */
  title: 28,
  /** `Title order={4}`: the heading over a card. */
  heading: 20,
  /** `Text` at its default size: an option's name, a poll's on a list card. */
  name: 16,
  /** The option row in a ballot. */
  option: 32,
  /** `Text size="sm"`: the sentences beside and under everything. */
  line: 12,
  /** `Text size="xs"`: who created the poll, and the notes in the form. */
  note: 10,
} as const

/** A badge, at the height Mantine draws one. */
const badge = 20

/** A button or an input, likewise. Both are 36 at the size the app uses. */
const control = 36

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
      <Stack gap="xs">
        <Group justify="space-between" align="flex-start" gap="sm" wrap="nowrap">
          <Skeleton height={compact ? bar.name : bar.title} width="55%" radius="sm" />
          <Skeleton height={badge} width={compact ? 88 : 104} radius="xl" />
        </Group>
        <Skeleton height={bar.note} width={148} radius="sm" />
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

/** The five stars an option is scored with; see StarRating. */
function StarsShape() {
  return (
    <Group gap={6} wrap="nowrap" style={{ flex: 'none' }}>
      {Array.from({ length: 5 }, (_, i) => (
        <Skeleton key={i} height={20} width={20} radius="sm" />
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
 */
function BallotShape({ rows }: { rows: number }) {
  return (
    <Stack gap="sm">
      {Array.from({ length: rows }, (_, i) => (
        <Fragment key={i}>
          <Group justify="space-between" wrap="nowrap" gap="sm">
            <Skeleton height={bar.option} width="45%" radius="sm" />
            <StarsShape />
          </Group>
          <Divider />
        </Fragment>
      ))}
      {/* Two lines of it: when the results unlock, and that the vote can be
          changed until they do. See RevealNote. */}
      <Group justify="space-between" wrap="wrap" gap="sm">
        <Stack gap={2} maw="100%">
          <Skeleton height={bar.line} width={360} maw="100%" radius="sm" />
          <Skeleton height={bar.line} width={232} maw="100%" radius="sm" />
        </Stack>
        <Skeleton height={control} width={124} radius="md" />
      </Group>
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
      <Skeleton height={22} width="60%" radius="sm" />
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
 * The two that are left out are genuinely conditional and stay that way: the
 * tie-breaks, which most polls do not have, and the full ranking's button,
 * which is drawn only from three options up (see FullRanking) and so would
 * need an option count this is not always given.
 */
function TallyShape({ options }: { options: number }) {
  return (
    <Stack gap="md">
      <BannerShape />

      <Stack gap={2}>
        <Skeleton height={bar.heading} width={112} radius="sm" />
        <Card withBorder p="sm">
          <Stack gap="xs">
            {Array.from({ length: options }, (_, i) => (
              <div key={i}>
                <Group justify="space-between" mb={2} wrap="nowrap" gap="xs">
                  <Skeleton height={bar.line} width="35%" radius="sm" />
                  <Skeleton height={bar.line} width={104} radius="sm" />
                </Group>
                {/* A Progress bar, at the height and radius Mantine draws
                    one; the one shape here that is not a line of text. */}
                <Skeleton height={8} radius="md" />
              </div>
            ))}
          </Stack>
        </Card>
      </Stack>

      {/* The runoff: the two finalists with what each was preferred by, and
          the line counting the ballots that split them evenly. Three lines
          and no more — the sentences under them explain a runoff that tied,
          which is the rare ending rather than the ordinary one. */}
      <Stack gap={2}>
        <Skeleton height={bar.heading} width={192} radius="sm" />
        <Card withBorder p="sm">
          <Stack gap="xs">
            {/* The finalists are named, so those two are a proportion; the
                line under them is the same sentence on every poll. */}
            <Skeleton height={bar.line} width="48%" radius="sm" />
            <Skeleton height={bar.line} width="44%" radius="sm" />
            <Skeleton height={bar.line} width={216} maw="100%" radius="sm" />
          </Stack>
        </Card>
      </Stack>
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
  rows = 5,
  finished = false,
  tallied = false,
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
          <BallotShape rows={rows} />
        </Loading>
      </Stack>
    </Card>
  )
}

/** The poll list: its heading, its button, and a page of cards. */
export function PollListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <Loading>
      <Stack maw={720} mx="auto" gap="md">
        <Group justify="space-between">
          <Skeleton height={bar.title} width={148} radius="sm" />
          <Skeleton height={control} width={104} radius="md" />
        </Group>
        <Stack gap="md">
          {Array.from({ length: rows }, (_, i) => (
            <Card withBorder key={i}>
              {/* The same heading the poll's own page carries, at card size,
                  because the card is that heading and nothing else. */}
              <PollHeadingShape compact />
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
export function ResultsSkeleton({ options = 5 }: { options?: number }) {
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
            <Skeleton height={26} width={30} radius="xl" />
            <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
              <Group gap="xs" wrap="nowrap">
                <Skeleton height={bar.name} width="45%" radius="sm" />
                <Skeleton height={bar.line} width={56} radius="sm" />
              </Group>
              <Skeleton height={bar.line} width="70%" radius="sm" />
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
        <Skeleton height={bar.heading} width={76} radius="sm" />
        {/* The border and the rules are the table's own; the cells inside them
            are one bar per row, at the padding a table cell has. */}
        <Card withBorder p={0} radius="sm">
          <Stack gap={0}>
            <Box px="xs" py={7}>
              <Skeleton height={bar.name} width="45%" radius="sm" />
            </Box>
            <Divider />
            {Array.from({ length: rows }, (_, i) => (
              <Fragment key={i}>
                <Box px="xs" py={7}>
                  <Skeleton height={bar.line} radius="sm" />
                </Box>
                <Divider />
              </Fragment>
            ))}
            <Box px="xs" py={7}>
              <Skeleton height={bar.name} width="30%" radius="sm" />
            </Box>
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
      <Skeleton height={bar.heading} width={label} radius="sm" />
      {children}
    </Stack>
  )
}

/**
 * The create form being prefilled from a poll being duplicated, which is the
 * only time it waits for anything: its centred title, its five labelled
 * sections, and the button that creates the poll.
 *
 * The three cards are drawn as cards because that is what they are — who may
 * vote, what the poll shows, and the options themselves each sit in one, and
 * a flat run of fields stood in for a form that has not looked like that for
 * some time. What is inside them is deliberately the part both kinds of poll
 * share: an invite poll asks for emails here and an open one puts up a
 * warning, and the shape a duplicate will take is not known until the poll it
 * is copied from lands.
 */
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
        <Skeleton height={bar.title} width={132} radius="sm" />

        <Stack gap={6}>
          {['100%', '100%', '72%'].map((w, i) => (
            <Skeleton key={i} height={bar.name} width={w} radius="sm" />
          ))}
        </Stack>

        <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="md">
          {Array.from({ length: 3 }, (_, i) => (
            <Card key={i} withBorder p="md">
              <Stack gap="sm">
                <Skeleton height={34} width={34} radius="md" />
                <Skeleton height={bar.heading} width="70%" radius="sm" />
                <Skeleton height={bar.line} width="90%" radius="sm" />
                <Skeleton height={control} width={128} radius="md" />
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
                <Skeleton height={bar.name} radius="sm" />
              </Box>
            ))}
          </Group>
          <Skeleton height={1} radius={0} />
        </Stack>
      </Stack>
    </Loading>
  )
}

export function FormSkeleton() {
  return (
    <Loading>
      <Stack maw={560} mx="auto" gap="md">
        <Group justify="center">
          <Skeleton height={bar.title} width={168} radius="sm" />
        </Group>

        <FieldShape label={44}>
          <Skeleton height={control} radius="md" />
        </FieldShape>

        <FieldShape label={92}>
          {/* A textarea of two rows, which is what the description opens at. */}
          <Skeleton height={62} radius="md" />
        </FieldShape>

        <FieldShape label={62}>
          <Card withBorder p="sm">
            <Stack gap="xs">
              <Skeleton height={control} radius="md" />
              <Skeleton height={62} radius="md" />
            </Stack>
          </Card>
        </FieldShape>

        <FieldShape label={112}>
          <Card withBorder p="sm">
            <Stack gap="sm">
              {[132, 108, 176, 140].map((w, i) => (
                <Group key={i} gap="sm" wrap="nowrap">
                  <Skeleton height={badge} width={38} radius="xl" />
                  <Skeleton height={bar.name} width={w} radius="sm" />
                </Group>
              ))}
            </Stack>
          </Card>
        </FieldShape>

        <FieldShape label={68}>
          <Card withBorder p="sm">
            <Stack gap="sm">
              <Skeleton height={bar.note} width="60%" radius="sm" />
              {Array.from({ length: 2 }, (_, i) => (
                <Group key={i} gap="xs" wrap="nowrap" align="flex-start">
                  <Skeleton height={control} radius="md" style={{ flex: 1 }} />
                  <Skeleton height={28} width={28} radius="md" />
                  <Skeleton height={28} width={28} radius="md" />
                </Group>
              ))}
              <Skeleton height={30} width={96} radius="md" />
            </Stack>
          </Card>
        </FieldShape>

        <Group justify="flex-end">
          <Skeleton height={control} width={132} radius="md" />
        </Group>
      </Stack>
    </Loading>
  )
}
