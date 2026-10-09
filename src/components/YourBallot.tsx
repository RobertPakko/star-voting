import { useEffect, useState } from 'react'
import { Card, Group, Stack, Text, Title } from '@mantine/core'
import { StarIcon } from '@phosphor-icons/react'
import { supabase } from '../lib/supabase'
import { formatWindow } from '../lib/schedule'
import { use24HourTime } from '../lib/clock'
import { Reveal } from './Reveal'
import { YourBallotSkeleton } from './Skeletons'
import type { PollOption } from '../lib/types'
import classes from './YourBallot.module.css'

/** How many stars an option is scored out of; the ballot's own scale. */
const STARS = 5

/**
 * What *you* scored, on the results of a poll that does not publish its
 * ballots.
 *
 * A poll created without `show_ballots` shows nobody else's ballot, and that
 * is the setting working. What it was also withholding was the reader's own --
 * the one ballot in the poll they wrote, and one they had in front of them a
 * stage earlier behind *Edit vote*. So a voter who scored five options, waited
 * for the group and came back to the tally had no way to see what they had
 * said: every number on that page is everybody's added together, and none of
 * it was theirs.
 *
 * It stands where the published sheet would have stood, and only there: a poll
 * that publishes its ballots is already showing this one, on a grid with
 * everybody else's, and a copy of it above that grid would be the same ballot
 * said twice. See `PollDetail`, which picks between the two.
 *
 * **It discloses nothing.** `poll_ballot_scores` reads the caller's own ballot
 * and no other, at any stage of any poll, which is why this needs no new door
 * and no new grant: it is the same function *Edit vote* fills the ballot back
 * in from, asked one stage later.
 *
 * **Both kinds of poll, two ways of getting the scores.** An invite poll's are
 * read here, through `poll_ballot_scores`. An open poll's arrive already in
 * hand: `open_poll_view` returns `your_scores` at every stage, found by the
 * account that cast the ballot when the reader is signed in and by this
 * browser's `voter_key` otherwise -- so on a finished open poll the reader gets
 * their ballot back on any device they voted from signed in, and on the one
 * browser they voted from signed out. The page hands those in as `scores`, and
 * nothing is read.
 */
export function YourBallot({
  pollId,
  options,
  scores: given,
}: {
  pollId: string
  /**
   * The poll's options, for the names and the order.
   *
   * The page's list rather than the tally's: this card is about the ballot
   * rather than about the result, so the rows run down it in the order the
   * options are in -- which is the order the ballot itself was scored in --
   * rather than in the order the score round ranked them.
   */
  options: PollOption[]
  /**
   * The ballot, where the page already holds it -- an open poll's
   * `your_scores`. Absent, it is read for the signed-in account.
   */
  scores?: Record<string, number>
}) {
  return given ? (
    <BallotRows options={options} scores={given} />
  ) : (
    <ReadBallot pollId={pollId} options={options} />
  )
}

function ReadBallot({ pollId, options }: { pollId: string; options: PollOption[] }) {
  // Read every time the card is drawn, like the tally above it and the sheet
  // it stands in place of. A closed poll can be opened again, take a changed
  // vote and be closed again without telling anybody holding a copy of this,
  // so nothing is held: see the note in `Results`, which is the same trade
  // and the same reasoning.
  const [scores, setScores] = useState<Record<string, number> | null>(null)
  // Said quietly, and not in red. Everything else on this page is
  // load-bearing -- the tally is the answer the poll was run to get -- and
  // this is a reminder of something the reader already knows they did, so a
  // line of red would be the most alarming thing on a page whose news is
  // good. It says what happened and the page carries on around it.
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    // Cleared as well as re-read, because one page serves every question of a
    // poll and this is the part of it that differs: a crossing must not leave
    // the last question's ballot on screen under the next question's heading.
    setScores(null)
    setFailed(false)

    let cancelled = false
    supabase.rpc('poll_ballot_scores', { p_poll_id: pollId }).then(({ data, error }) => {
      if (cancelled) return
      if (error) setFailed(true)
      else setScores((data as Record<string, number>) ?? {})
    })

    return () => {
      cancelled = true
    }
  }, [pollId])

  if (failed) {
    return (
      <Text size="sm" c="dimmed">
        Your own ballot could not be read just now.
      </Text>
    )
  }

  if (!scores) return <YourBallotSkeleton rows={options.length || undefined} />

  return <BallotRows options={options} scores={scores} />
}

function BallotRows({
  options,
  scores,
}: {
  options: PollOption[]
  scores: Record<string, number>
}) {
  const h24 = use24HourTime()
  // Faded in over the shape that was standing in for it, as the tally and the
  // sheet are; see Reveal.
  return (
    <Reveal>
      <Stack gap={2}>
        <Title order={2} size="h4">
          Your ballot
        </Title>
        <Card withBorder p="sm">
          <Stack gap="xs">
            {options.map((option) => {
              // The one thing a time poll changes about this card, applied to
              // every poll because it costs nothing to: an ordinary poll's
              // options are not window starts and come back exactly as they
              // went in. See relabelResults, which does this to the tally.
              const name = formatWindow(option.name, h24)

              return (
                <Group key={option.id} justify="space-between" wrap="nowrap" gap="sm">
                  <Text size="sm" truncate>
                    {name}
                  </Text>
                  {/* An option with no score on this ballot reads as 0, which
                      is what it counts as everywhere else in the app and what
                      the tally above counted it as: a ballot cast before its
                      creator added the option scores that option zero. */}
                  <Score name={name} value={scores[option.id] ?? 0} />
                </Group>
              )
            })}
          </Stack>
        </Card>
      </Stack>
    </Reveal>
  )
}

/**
 * One option's score, in the units it was given in.
 *
 * Stars rather than a number, because stars are what the reader pressed: this
 * card exists to hand back the ballot they filled in, and a column of digits
 * is a different object from the one they remember.
 *
 * Not `StarRating` with its handlers stubbed out. That control is five buttons
 * in a radio group, and a score nobody can change must not offer a tab stop, a
 * cursor or an arrow key that moves nothing. So a screen reader is given the
 * number instead, on the group -- the one place five repeated icons would be
 * worse than saying it.
 */
function Score({ name, value }: { name: string; value: number }) {
  return (
    <Group gap={2} wrap="nowrap" aria-label={`${name}: ${value} of ${STARS}`}>
      {Array.from({ length: STARS }, (_, index) => (
        <StarIcon
          key={index}
          size={18}
          weight="fill"
          aria-hidden
          className={classes.star}
          data-filled={index < value || undefined}
        />
      ))}
    </Group>
  )
}
