import type { ReactNode } from 'react'
import { Card, Group, Skeleton, Stack, VisuallyHidden } from '@mantine/core'

/**
 * The shapes each page draws while it is waiting for its first read.
 *
 * Two rules keep them honest:
 *
 *  - **A skeleton claims only what the page always has.** The poll list draws
 *    three cards because the wait is over long before anyone counts them; it
 *    does not draw a winner badge, which most polls do not have. A
 *    placeholder for something that then fails to appear is a small lie the
 *    reader has to un-learn.
 *  - **They are one component per page, next to nothing else.** Every skeleton
 *    in the app is in this file, so a page and its stand-in are changed
 *    together rather than drifting apart; the failure mode of skeletons is
 *    that they slowly stop resembling anything.
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

/** Title, a settings row, and a few cards: the shape of every poll page. */
export function PollPageSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <Loading>
      <Stack maw={640} mx="auto" gap="lg">
        <Stack gap={8}>
          <Skeleton height={28} width="55%" radius="sm" />
          <Skeleton height={12} width="80%" radius="sm" />
          <Group gap="xs" mt={4}>
            {[64, 128, 108, 140].map((w, i) => (
              <Skeleton key={i} height={20} width={w} radius="xl" />
            ))}
          </Group>
        </Stack>
        <Stack gap="md">
          {Array.from({ length: rows }, (_, i) => (
            <Card withBorder key={i}>
              <Group justify="space-between" wrap="nowrap">
                <Skeleton height={14} width="45%" radius="sm" />
                <Skeleton height={20} width={110} radius="sm" />
              </Group>
            </Card>
          ))}
        </Stack>
      </Stack>
    </Loading>
  )
}

/**
 * One question of a poll, while the poll around it stays on screen.
 *
 * The only stand-in here for part of a page rather than a whole one, and the
 * reason is that the pages of a multi-question poll are mostly the same page.
 * The heading, the poll's terms and the question strip belong to the poll
 * rather than to the question, so they are already right for the question
 * being opened and stay where they are; this fills the hole underneath them
 * while that question's own ballot is read. Crossing between two questions
 * would otherwise blink the whole poll away and back, and a strip that
 * vanishes at the moment it is being used to navigate is the one part of the
 * page that must not.
 *
 * It claims a title and a row per option, which is what every question has.
 */
export function QuestionSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <Loading>
      <Stack gap="lg">
        <Skeleton height={22} width="45%" radius="sm" />
        <Stack gap="md">
          {Array.from({ length: rows }, (_, i) => (
            <Card withBorder key={i}>
              <Group justify="space-between" wrap="nowrap">
                <Skeleton height={14} width="45%" radius="sm" />
                <Skeleton height={20} width={110} radius="sm" />
              </Group>
            </Card>
          ))}
        </Stack>
      </Stack>
    </Loading>
  )
}

/** The poll list: its heading, its button, and a page of cards. */
export function PollListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <Loading>
      <Stack gap="lg" maw={720} mx="auto">
        <Group justify="space-between">
          <Skeleton height={26} width={160} radius="sm" />
          <Skeleton height={36} width={104} radius="sm" />
        </Group>
        <Stack gap="sm">
          {Array.from({ length: rows }, (_, i) => (
            <Card withBorder key={i}>
              <Stack gap={8}>
                <Group justify="space-between" wrap="nowrap" align="flex-start">
                  <Skeleton height={16} width="45%" radius="sm" />
                  <Skeleton height={20} width={96} radius="xl" />
                </Group>
                <Skeleton height={10} width="30%" radius="sm" />
                <Group gap="xs" mt={2}>
                  {[92, 132, 112, 96].map((w, j) => (
                    <Skeleton key={j} height={20} width={w} radius="xl" />
                  ))}
                </Group>
              </Stack>
            </Card>
          ))}
        </Stack>
      </Stack>
    </Loading>
  )
}

/** The winner, then the score round: one labelled bar per option. */
export function ResultsSkeleton({ options = 4 }: { options?: number }) {
  return (
    <Loading>
      <Stack gap="lg">
        <Card withBorder>
          <Skeleton height={22} width="60%" radius="sm" />
        </Card>
        <Stack gap={4}>
          <Skeleton height={18} width={120} radius="sm" mb={4} />
          <Stack gap="xs">
            {Array.from({ length: options }, (_, i) => (
              <div key={i}>
                <Group justify="space-between" mb={6} wrap="nowrap">
                  <Skeleton height={10} width="35%" radius="sm" />
                  <Skeleton height={10} width={90} radius="sm" />
                </Group>
                <Skeleton height={8} radius="xl" />
              </div>
            ))}
          </Stack>
        </Stack>
      </Stack>
    </Loading>
  )
}

/**
 * The full ranking, while the modal waits for it: a place number, the option
 * on it, and the line saying how it was settled.
 *
 * `places` is the poll's option count, which is the number of places on every
 * poll that did not end in a tie -- and a tie for a place is rare enough that
 * drawing for it would be the lie the note at the top of this file warns
 * about, one place too few rather than one too many.
 */
export function RankingSkeleton({ places = 4 }: { places?: number }) {
  return (
    <Loading>
      <Stack gap="md">
        {Array.from({ length: places }, (_, i) => (
          <Group key={i} align="flex-start" wrap="nowrap" gap="sm">
            <Skeleton height={26} width={34} radius="xl" />
            <Stack gap={6} style={{ flex: 1 }}>
              <Skeleton height={12} width="45%" radius="sm" />
              <Skeleton height={10} width="70%" radius="sm" />
            </Stack>
          </Group>
        ))}
      </Stack>
    </Loading>
  )
}

/** The published ballot grid, which is a table however wide the poll is. */
export function BallotsSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <Loading>
      <Card withBorder>
        <Stack gap="sm">
          <Group justify="space-between">
            <Skeleton height={18} width={120} radius="sm" />
            <Skeleton height={12} width={64} radius="sm" />
          </Group>
          <Skeleton height={10} width="70%" radius="sm" />
          <Stack gap={6} mt={4}>
            {Array.from({ length: rows }, (_, i) => (
              <Skeleton key={i} height={24} radius="sm" />
            ))}
          </Stack>
        </Stack>
      </Card>
    </Loading>
  )
}

/** A form being prefilled: labelled fields, then the button that submits. */
export function FormSkeleton({ fields = 4 }: { fields?: number }) {
  return (
    <Loading>
      <Stack maw={560} mx="auto" gap="md">
        <Skeleton height={26} width={180} radius="sm" />
        {Array.from({ length: fields }, (_, i) => (
          <Stack gap={6} key={i}>
            <Skeleton height={10} width={90} radius="sm" />
            <Skeleton height={36} radius="sm" />
          </Stack>
        ))}
        <Group justify="flex-end">
          <Skeleton height={36} width={120} radius="sm" />
        </Group>
      </Stack>
    </Loading>
  )
}
