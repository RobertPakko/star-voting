import { Fragment, type ReactNode } from 'react'
import {
  Box,
  Card,
  Divider,
  Group,
  SimpleGrid,
  Skeleton,
  Stack,
  Switch,
  Title,
  VisuallyHidden,
} from '@mantine/core'
import { RESULTS_ROWS_MAX, SCORING_ROWS_MAX } from '../lib/resultsRows'
import { isDaily, toMinutes } from '../lib/schedule'
import type { PollSchedule } from '../lib/types'
import { usePageTitle } from '../lib/pageTitle'
import { PollTitleText } from './PollTitleText'
import { PollHeading, type PollHeadingProps } from './PollHeading'
import { SWITCH_LABELS } from '../lib/notificationSettings'
import { countsRaised } from '../lib/donate'

/*
 * Every loading shape in the app, kept in one file so each stays in step with
 * its page. The rules:
 *
 *  - Claim only what the page always has (no description bar; most polls have
 *    none) -- but do claim everything it always has.
 *  - Only a wait that actually happens gets a shape.
 *  - Build from the same containers, gaps and order as the page, so the swap
 *    is a fill rather than a jump.
 *  - Bars sit centred in a box the height of the line they replace (`Bar`),
 *    so lines don't shrink and add up to a shorter page.
 *
 * See "Waiting" in AGENTS.md.
 */

/** Hides the shapes from screen readers and announces "Loading…" instead. */
function Loading({ children }: { children: ReactNode }) {
  return (
    <div role="status" aria-busy="true">
      <VisuallyHidden>Loading…</VisuallyHidden>
      <div aria-hidden>{children}</div>
    </div>
  )
}

/** Each kind of text line: the height Mantine gives it, and the bar drawn inside. */
const text = {
  /** `Title order={1}` */
  page: { line: 44, bar: 34 },
  /** `Title size="h2"` */
  title: { line: 35, bar: 28 },
  /** `Title size="h4"` */
  heading: { line: 26, bar: 20 },
  /** `Text size="lg"` */
  banner: { line: 29, bar: 22 },
  /** `Text` */
  name: { line: 25, bar: 16 },
  /** `Text size="sm"` */
  line: { line: 20, bar: 12 },
  /** `Text size="xs"` */
  note: { line: 17, bar: 10 },
} as const

/** One line of text. `grow` takes the row's slack, so a percentage width means something. */
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

const badge = 20
/** A button or input at the app's size. */
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
 * Cap on ballot rows. A crossing knows a question's option count but not its
 * kind, so a calendar with a hundred windows would otherwise get a hundred
 * rows of stars. Short is the safe direction.
 */
const BALLOT_ROWS_MAX = 10

/**
 * The shape of `PollHeading`, minus the (optional) description. A title
 * already known -- handed over from the list -- is drawn for real.
 */
function PollHeadingShape({ compact = false, title }: { compact?: boolean; title?: string }) {
  return (
    <Stack gap="xs">
      <Stack gap={2}>
        <Group align="flex-start" gap="sm" wrap="nowrap">
          {title ? (
            <KnownTitle title={title} />
          ) : (
            <Bar kind={compact ? 'name' : 'title'} width="70%" grow />
          )}
          <Skeleton
            height={badge}
            width={compact ? 88 : 104}
            radius="xl"
            style={{ flex: 'none' }}
          />
        </Group>
        <Bar kind="note" width={96} />
      </Stack>
      {/* PollTags' four badges. */}
      <Group gap="xs">
        {[86, 96, 118, 74].map((w, i) => (
          <Skeleton key={i} height={badge} width={w} radius="xl" />
        ))}
      </Group>
    </Stack>
  )
}

/** StarRating: five 20px stars in buttons padded 6px by 3px. */
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
 * The inside of the card a question is answered in (the caller draws the
 * card). `collecting` draws the option list instead: names, no stars, and two
 * buttons.
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

/** Two lines of what happens next, beside the buttons that end the card. */
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
 * A calendar's height: a week is a 58px heading row over 40px an hour of the
 * poll's `window`; a daily poll opens on the month. A poll that has collected
 * times may have widened past `window` -- a little short is the safe side.
 */
function calendarGridHeight(schedule: PollSchedule): number {
  return isDaily(schedule)
    ? 536
    : 58 +
        Math.max(1, (toMinutes(schedule.window.end) - toMinutes(schedule.window.start)) / 60) * 40
}

/** PaintCalendar's header: previous, range, next, and the view switch. */
function CalendarHeaderShape() {
  return (
    <Group justify="space-between" wrap="nowrap" gap="sm">
      <Group gap={8} wrap="nowrap">
        <Skeleton height={32} width={32} radius="md" />
        <Skeleton height={32} width={190} radius="md" />
        <Skeleton height={32} width={32} radius="md" />
      </Group>
      <Skeleton height={32} width={189} radius="md" />
    </Group>
  )
}

/** The inside of a time ballot's card. See TimeBallotCard. */
function CalendarShape({ schedule }: { schedule: PollSchedule }) {
  return (
    <Stack gap="sm">
      <Stack gap="xs">
        <Bar kind="line" width={420} />
        <Group justify="space-between" wrap="wrap" gap="sm">
          <Bar kind="note" width={340} />
          <Skeleton height={31} width={214} radius="md" />
        </Group>
        <CalendarHeaderShape />
        <Skeleton height={calendarGridHeight(schedule)} mt={8} radius="md" />
      </Stack>
      <FooterShape buttons={[112]} />
    </Stack>
  )
}

/**
 * A one-line card: the winner banner, or the notice a question nobody
 * answered puts up. Same shape, so it is safe when which one is unknown.
 */
function BannerShape() {
  return (
    <Card withBorder>
      <Bar kind="banner" width="60%" />
    </Card>
  )
}

/**
 * A finished question's tally, in `Results`' order: banner, runoff, scoring
 * round. The runoff is always drawn, since a poll with a tally always has two
 * finalists. Tie-break buttons are left out (rare, and no taller than the
 * heading they sit beside).
 */
function TallyShape({ options }: { options?: number }) {
  // The scoring round's own cap; see resultsRows.ts.
  const rows = Math.min(options ?? 5, SCORING_ROWS_MAX)

  return (
    <Stack gap="md">
      <BannerShape />

      {/* RunoffChart: the half pie and a finalist under each end. */}
      <Stack gap={2}>
        <Bar kind="heading" width={60} />
        <Card withBorder p="sm">
          <Stack gap="xs" align="center">
            <Skeleton height={120} width={240} style={{ borderRadius: '120px 120px 0 0' }} />
            <Group justify="space-between" align="flex-start" wrap="nowrap" w="100%" maw={360}>
              <Stack gap={0} align="flex-start">
                <Bar kind="line" width={96} />
                <Bar kind="line" width={112} />
              </Stack>
              <Stack gap={0} align="flex-end">
                <Bar kind="line" width={96} />
                <Bar kind="line" width={112} />
              </Stack>
            </Group>
            <Bar kind="line" width={232} />
          </Stack>
        </Card>
      </Stack>

      <Stack gap={2}>
        <Bar kind="heading" width={68} />
        <Card withBorder p="sm">
          <Stack gap="xs">
            {Array.from({ length: rows }, (_, i) => (
              <div key={i}>
                <Group justify="space-between" mb={2} wrap="nowrap" gap="xs">
                  <Bar kind="line" width="35%" grow />
                  <Bar kind="line" width={104} />
                </Group>
                {/* A Progress bar. */}
                <Skeleton height={8} radius="md" />
              </div>
            ))}
            {/* The "and N more" line past the cap. */}
            {options !== undefined && options > SCORING_ROWS_MAX && <Bar kind="line" width="75%" />}
          </Stack>
        </Card>
      </Stack>

      {/* *See the full ranking*, drawn from three options up. */}
      {options !== undefined && options >= 3 && (
        <Divider labelPosition="center" label={<Skeleton height={26} width={141} radius="sm" />} />
      )}
    </Stack>
  )
}

/** QuestionStrip before the read: the count of questions is known, their names aren't. */
function StripShape({ questions }: { questions: number }) {
  return (
    <>
      <Stack gap="xs">
        <Group justify="space-between" wrap="nowrap" gap="sm">
          <Bar kind="line" width={92} />
          <Bar kind="line" width={48} />
        </Group>
        <Group gap="xs">
          {Array.from({ length: questions }, (_, i) => (
            <Skeleton key={i} height={badge} width={[132, 112, 148, 120][i % 4]} radius="xl" />
          ))}
        </Group>
      </Stack>
      <Divider />
    </>
  )
}

/** `Waiting` in PollDetail: *your vote is in*, the count, the progress bar, *Edit vote*. */
function WaitingShape() {
  return (
    <Stack gap="sm">
      <Group justify="space-between" wrap="nowrap" gap="xs">
        <Bar kind="name" width={112} />
        <Skeleton height={badge} width={72} radius="xl" style={{ flex: 'none' }} />
      </Group>
      <Skeleton height={8} radius="md" />
      <FooterShape buttons={[96]} />
    </Stack>
  )
}

/**
 * Which ending a heading handed over from the list says is coming. On a poll
 * of several questions, `tally` is only claimed when results are out without
 * a close (so every question has one; see `QuestionSkeleton`).
 */
function pageStage(
  heading: PollHeadingProps | undefined,
  voted: boolean,
): 'collecting' | 'tally' | 'ended' | 'waiting' | 'ballot' {
  if (!heading) return 'ballot'
  const { state } = heading
  const several = (heading.turnout?.questionCount ?? 1) > 1
  if (state.soliciting) return 'collecting'
  if (state.resultsAvailable && (!several || !state.closed)) return 'tally'
  if (state.resultsAvailable || state.closed) return 'ended'
  if (heading.mode === 'invite' && voted) return 'waiting'
  return 'ballot'
}

/**
 * A whole poll page. Opened from the list, it gets the card's heading and
 * draws the stage that heading implies; opened any other way, a ballot.
 */
export function PollPageSkeleton({
  rows,
  title,
  heading,
  voted = false,
}: {
  rows?: number
  title?: string
  /**
   * The list card's heading, drawn for real (it's also where the heading
   * flight lands; see lib/headingFlight.ts).
   */
  heading?: PollHeadingProps
  /** Whether this reader voted, as the list card knew it. */
  voted?: boolean
}) {
  const stage = pageStage(heading, voted)
  const options = rows ?? heading?.turnout?.optionCount
  const questions = heading?.turnout?.questionCount ?? 1
  const strip = questions > 1 ? <StripShape questions={questions} /> : null

  return (
    <Loading>
      <Stack maw={720} mx="auto" gap="md">
        {heading ? <PollHeading {...heading} /> : <PollHeadingShape title={title} />}
        {stage === 'tally' || stage === 'ended' ? (
          <Stack gap="md">
            {strip}
            {stage === 'tally' ? <TallyShape options={options || undefined} /> : <BannerShape />}
          </Stack>
        ) : (
          <Card withBorder>
            <Stack gap="sm">
              {strip}
              {stage === 'waiting' ? (
                <WaitingShape />
              ) : (
                // A collecting list may really be empty; a ballot never is.
                <BallotShape
                  rows={stage === 'collecting' ? (options ?? 5) : options || 5}
                  collecting={stage === 'collecting'}
                />
              )}
            </Stack>
          </Card>
        )}
      </Stack>
    </Loading>
  )
}

/**
 * One question's half of the page, while the poll around it stays put during
 * a crossing. The strip and name box are handed in and drawn for real (they
 * belong to the poll, and a typed name must survive), outside `Loading` so
 * screen readers can still reach them.
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
  /** The question's option count, where known (invite polls only). */
  rows?: number
  /** The poll has stopped taking answers: the strip moves out of the card. */
  finished?: boolean
  /**
   * Expect a tally rather than the empty-question notice. Certain when
   * results are out without a close (every invitee answered every question);
   * otherwise a guess borrowed from the question being left.
   */
  tallied?: boolean
  collecting?: boolean
  /** Only set by the time ballot's own chunk wait; a crossing doesn't know the kind. */
  schedule?: PollSchedule
  nameField?: ReactNode
  strip?: ReactNode
}) {
  if (finished) {
    return (
      <Stack gap="md">
        {strip}
        <Loading>{tallied ? <TallyShape options={rows} /> : <BannerShape />}</Loading>
      </Stack>
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

/** The poll list. Five cards fill the first screen; nobody counts the rest. */
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
              {/* The compact heading, and the archive button beside it. */}
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

/** The tally while `Results` reads it -- the same shape `QuestionSkeleton` may already show. */
export function ResultsSkeleton({ options }: { options?: number }) {
  return (
    <Loading>
      <TallyShape options={options} />
    </Loading>
  )
}

/** The full ranking modal. `places` is the option count (ties for a place are rare). */
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
 * The published ballot grid. Rows are drawn whole: the column count isn't
 * known yet.
 */
export function BallotsSkeleton({
  rows = 5,
  schedule,
}: {
  rows?: number
  /** A time poll's sheet is drawn as a calendar; see ScheduleBallots. */
  schedule?: PollSchedule | null
}) {
  return (
    <Loading>
      <Stack gap={2}>
        {/* The heading, and the CSV download beside it. */}
        <Group justify="space-between" wrap="nowrap" align="center" gap="xs">
          <Bar kind="heading" width={76} />
          <IconShape />
        </Group>
        {schedule ? (
          <ReadCalendarShape schedule={schedule} picker />
        ) : (
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
        )}
      </Stack>
    </Loading>
  )
}

/** A read-only calendar while its chunk loads. */
export function ReadCalendarSkeleton({
  schedule,
  picker = false,
}: {
  schedule: PollSchedule
  /** The published sheet's, with the voter picker above. */
  picker?: boolean
}) {
  return (
    <Loading>
      <ReadCalendarShape schedule={schedule} picker={picker} />
    </Loading>
  )
}

function ReadCalendarShape({ schedule, picker }: { schedule: PollSchedule; picker: boolean }) {
  return (
    <Card withBorder p="sm">
      <Stack gap="xs">
        {picker && (
          <>
            <Skeleton height={36} radius="sm" />
            <Bar kind="note" width={180} />
          </>
        )}
        <Group justify="space-between" wrap="wrap" gap="sm">
          <Bar kind="note" width={220} />
          <Bar kind="note" width={160} />
        </Group>
        <CalendarHeaderShape />
        <Skeleton height={calendarGridHeight(schedule)} mt={8} radius="md" />
      </Stack>
    </Card>
  )
}

/** One `Table` row. */
function TableRowShape({ width }: { width?: string }) {
  return (
    <Box px="xs" h={36} style={{ display: 'flex', alignItems: 'center' }}>
      <Skeleton height={text.line.bar} width={width} radius="sm" />
    </Box>
  )
}

/**
 * The reader's own ballot while `YourBallot` reads it. Capped at the results
 * row limit; the card itself shows every option.
 */
export function YourBallotSkeleton({
  rows = 5,
  schedule,
}: {
  rows?: number
  schedule?: PollSchedule | null
}) {
  return (
    <Loading>
      <Stack gap={2}>
        <Bar kind="heading" width={84} />
        {schedule ? (
          <ReadCalendarShape schedule={schedule} picker={false} />
        ) : (
          <Card withBorder p="sm">
            <Stack gap="xs">
              {Array.from({ length: Math.min(rows, RESULTS_ROWS_MAX) }, (_, i) => (
                <Group key={i} justify="space-between" wrap="nowrap" gap="sm">
                  <Bar kind="line" width="40%" grow />
                  {/* Five 18px stars, 2px apart. */}
                  <Skeleton height={18} width={98} radius="sm" />
                </Group>
              ))}
            </Stack>
          </Card>
        )}
      </Stack>
    </Loading>
  )
}

function FieldShape({ label, children }: { label: number; children: ReactNode }) {
  return (
    <Stack gap={2}>
      <Bar kind="heading" width={label} />
      {children}
    </Stack>
  )
}

/** The Caveat signature on the donate and contact pages: a taller line than any in `text`. */
function SignatureShape() {
  return (
    <Box h={34} style={{ display: 'flex', alignItems: 'center' }}>
      <Skeleton height={20} width={72} radius="sm" />
    </Box>
  )
}

/** The About page down to its tab strip (the panels differ in length). */
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

        {/* `SampleCard` in About.tsx. */}
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

        {/* *Watch intro*. */}
        <Divider label={<Skeleton height={26} width={118} radius="sm" />} />

        {/* `Tabs.List grow`. */}
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
 * The create form, as a new poll opens it (invite list, option list). A
 * duplicate may differ in two cards, which isn't known until its source lands.
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
          {/* A two-row textarea. */}
          <Skeleton height={57} radius="md" />
        </FieldShape>

        {/* Who may vote: mode, invitees box, "invite me too" checkbox. */}
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

        {/* Kind, then two option rows and *Add option*. */}
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

/** Notification switches while the account's settings load. */
export function SwitchesSkeleton({ labels }: { labels: readonly string[] }) {
  return (
    <Loading>
      <SwitchRows labels={labels} />
    </Loading>
  )
}

function SwitchRows({ labels }: { labels: readonly string[] }) {
  return (
    <Stack gap="sm">
      {labels.map((label) => (
        <SwitchShape key={label} label={label} />
      ))}
    </Stack>
  )
}

/**
 * One switch, laid over an invisible real one so the shape is exactly the
 * label's width -- the popover sizes to its widest row and would otherwise jump.
 */
function SwitchShape({ label }: { label: string }) {
  return (
    <Box pos="relative">
      <Switch label={label} readOnly tabIndex={-1} style={{ visibility: 'hidden' }} />
      <Group gap="sm" wrap="nowrap" pos="absolute" inset={0}>
        <Skeleton height={20} width={38} radius="xl" style={{ flex: 'none' }} />
        <Skeleton height={text.line.bar} radius="sm" style={{ flex: 1 }} />
      </Group>
    </Box>
  )
}

export function SettingsSkeleton() {
  return (
    <Loading>
      <Stack maw={720} mx="auto" gap="md">
        <Bar kind="title" width={160} />
        <Card withBorder>
          <SwitchRows labels={[SWITCH_LABELS.email, SWITCH_LABELS.push]} />
        </Card>
      </Stack>
    </Loading>
  )
}

/** The install guide, minus the per-device steps (they differ in length). */
export function GuideSkeleton() {
  return (
    <Loading>
      <Stack maw={720} mx="auto" gap="md">
        <Bar kind="page" width={220} />
        <Stack gap={0}>
          {['100%', '100%', '64%'].map((w, i) => (
            <Bar key={i} kind="name" width={w} />
          ))}
        </Stack>
        <Card withBorder>
          <Stack gap="xs">
            <Bar kind="heading" width={112} />
            <Bar kind="line" width="70%" />
          </Stack>
        </Card>
        <Skeleton height={control} radius="md" />
      </Stack>
    </Loading>
  )
}

/** The donate page; the raised count only where this build has a fundraiser. */
export function DonateSkeleton() {
  return (
    <Loading>
      <Stack maw={720} mx="auto" gap="md">
        <Bar kind="page" width={160} />
        {[
          ['100%', '30%'],
          ['100%', '100%', '100%', '60%'],
        ].map((lines, i) => (
          <Stack key={i} gap={0}>
            {lines.map((w, j) => (
              <Bar key={j} kind="name" width={w} />
            ))}
          </Stack>
        ))}
        <SignatureShape />
        <Card withBorder>
          <Stack gap="md">
            <Group gap="sm" wrap="nowrap">
              <Skeleton height={48} width={48} radius={12} />
              <Bar kind="heading" width={120} />
            </Group>
            <Stack gap={0}>
              {['100%', '100%', '40%'].map((w, i) => (
                <Bar key={i} kind="line" width={w} />
              ))}
            </Stack>
            {countsRaised && (
              <Stack gap={6}>
                <Skeleton height={22} width={200} my={4} radius="sm" />
                <Skeleton height={8} radius="xl" />
                <Bar kind="note" width={64} />
              </Stack>
            )}
            <Skeleton height={control} width={110} radius="md" />
          </Stack>
        </Card>
      </Stack>
    </Loading>
  )
}

export function ContactSkeleton() {
  return (
    <Loading>
      <Stack maw={720} mx="auto" gap="md">
        <Bar kind="page" width={140} />
        <Stack gap={0}>
          <Bar kind="name" width="100%" />
          <Bar kind="name" width="40%" />
        </Stack>
        <SignatureShape />
        <Card withBorder>
          <Stack gap="md">
            <FieldShape label={150}>
              <Skeleton height={control} radius="md" />
            </FieldShape>
            <FieldShape label={80}>
              {/* A six-row textarea. */}
              <Skeleton height={146} radius="md" />
            </FieldShape>
            <Skeleton height={control} width={140} radius="md" />
          </Stack>
        </Card>
      </Stack>
    </Loading>
  )
}

/** A known title, drawn exactly as `PollHeading` draws it. */
function KnownTitle({ title }: { title: string }) {
  usePageTitle(title)
  return (
    <Title order={1} size="h2" style={{ flex: '1 1 60%', minWidth: 0, wordBreak: 'break-word' }}>
      <PollTitleText>{title}</PollTitleText>
    </Title>
  )
}
