import { Fragment, type ReactNode } from 'react'
import { Box, Card, Divider, Group, Skeleton, Stack, VisuallyHidden } from '@mantine/core'

/**
 * The shapes each page draws while it is waiting for its first read.
 *
 * Three rules keep them honest:
 *
 *  - **A skeleton claims only what the page always has.** The poll list draws
 *    three cards because the wait is over long before anyone counts them; it
 *    does not draw a description, which most polls do not have. A placeholder
 *    for something that then fails to appear is a small lie the reader has to
 *    un-learn.
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
 * card — see `ResultsSkeleton`, which draws its tally under this, and
 * `QuestionSkeleton`, which draws this alone because it cannot yet know which
 * of the two is coming.
 */
function BannerShape() {
  return (
    <Card withBorder>
      <Skeleton height={22} width="60%" radius="sm" />
    </Card>
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
 * and drawn for real**, in the places the ballot draws them: the strip of
 * questions, and the name box on an open poll that shows its respondents.
 * Both belong to the poll's half of the page like the heading above does —
 * the same questions in the same order, the same name this browser is
 * answering under — and only happen to live inside the card a crossing
 * replaces. Stood in for, the strip greyed out and came back at the exact
 * moment a reader was using it to navigate, which is the thing this whole
 * stand-in exists to prevent, and it put the way out of the question behind
 * the wait; the name box went further and took what had been typed into it
 * with it. Drawn for real, the strip's links stay live and the name stays
 * typed, and nothing about either moves across a crossing: the badge marking
 * which question is open has already moved, because the address has, and the
 * tags take whatever colour the read gives them when it lands, which is a
 * tick appearing rather than a row of shapes filling in.
 *
 * They therefore sit outside the `Loading` wrapper, which hides what it holds
 * from screen readers. A real link or a real input in there would be one
 * nothing could reach: announced to nobody and still in the tab order.
 */
export function QuestionSkeleton({
  rows = 5,
  finished = false,
  nameField,
  strip,
}: {
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
  /** The name box, on the polls that ask for one; see VoterNameField. */
  nameField?: ReactNode
  /** The way between the poll's questions; see QuestionStrip. */
  strip?: ReactNode
}) {
  // Nothing under the strip but the one card both endings share. Which of the
  // two is coming is not knowable from here — a question of a finished poll
  // has a tally if anybody answered it and the notice if nobody did, and that
  // is a fact about the question being opened rather than about the poll — so
  // this claims the card they have in common and lets the score round arrive
  // under it. `Results` puts up `ResultsSkeleton` the moment it lands, whose
  // first shape is this one, so the wait continues rather than starting over.
  // A finished question asks for no name, which is why there is none here.
  if (finished) {
    return (
      <>
        {strip}
        <Loading>
          <BannerShape />
        </Loading>
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

/** The winner, then the score round: one labelled bar per option, in a card. */
export function ResultsSkeleton({ options = 4 }: { options?: number }) {
  return (
    <Loading>
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
      </Stack>
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
