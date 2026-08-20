import { Badge, Button, Group, Modal, Stack, Text } from '@mantine/core'
import { useDisclosure } from '@mantine/hooks'
import { countBadge } from '../lib/badgeColors'
import type { PollResults, RankingEntry, Tiebreak } from '../lib/types'
import { voters } from '../lib/plural'

/**
 * The whole field in placed order, behind a button.
 *
 * Kept out of the results page proper because most polls only ever need
 * their winner; but "what were the top three" is a real question, and the
 * score round on its own doesn't answer it: the score order ignores the
 * runoffs, which is exactly the part STAR adds.
 */
export function FullRanking({ results }: { results: PollResults }) {
  const [opened, modal] = useDisclosure(false)

  // With two options the ranking is the winner and the option it beat, both
  // already on screen; with one there is nothing to order.
  //
  // The optional chain is not redundant: the built app deploys on push while
  // migrations are applied by hand, so a browser can hold this code against a
  // database whose poll_tally predates `ranking`. Hide the button, don't crash
  // the results page.
  if (results.options.length < 3 || !results.ranking?.length) return null

  const nameById = new Map(results.options.map((o) => [o.id, o.name]))

  return (
    <>
      <Group justify="center">
        <Button variant="subtle" size="compact-sm" onClick={modal.open}>
          See the full ranking
        </Button>
      </Group>

      <Modal opened={opened} onClose={modal.close} title="Full ranking" size="lg" centered>
        <Stack gap="lg">
          <Text size="sm" c="dimmed">
            STAR names one winner. To order the rest, the method runs again on the options left
            standing: the winner steps out, the two highest scorers remaining go to a runoff for the
            next place, and so on down the list.
          </Text>

          <Stack gap="md">
            {results.ranking.map((entry) => (
              <Place key={entry.place} entry={entry} results={results} nameById={nameById} />
            ))}
          </Stack>
        </Stack>
      </Modal>
    </>
  )
}

function Place({
  entry,
  results,
  nameById,
}: {
  entry: RankingEntry
  results: PollResults
  nameById: Map<string, string>
}) {
  const total = entry.options[0].total_score

  // Standard competition rank on score alone, so options level on points
  // share a number. Shown only where it disagrees with the placing; which
  // is the whole reason this ranking isn't just the score round re-sorted.
  const scoreRank = 1 + results.options.filter((o) => o.total_score > total).length

  return (
    <Group align="flex-start" wrap="nowrap" gap="sm">
      <Badge {...countBadge} size="lg">
        {entry.place}
      </Badge>
      <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
        <Group gap="xs" wrap="nowrap">
          <Text fw={600} truncate>
            {entry.options.map((o) => o.name).join(' and ')}
          </Text>
          <Text size="sm" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
            {total} pts
          </Text>
          {scoreRank !== entry.place && (
            <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
              #{scoreRank} on score
            </Text>
          )}
        </Group>

        <Text size="sm" c="dimmed">
          {decision(entry, nameById)}
        </Text>

        {entry.tiebreaks.map((tb, i) => (
          <Text key={i} size="sm" c={tb.resolved_by === 'random' ? 'orange' : 'dimmed'}>
            {tiebreakNote(tb)}
          </Text>
        ))}
      </Stack>
    </Group>
  )
}

/** How this place was settled, in one line. */
function decision(entry: RankingEntry, nameById: Map<string, string>): string {
  const { runoff, finalists, options } = entry

  if (!runoff || finalists.length < 2) {
    return 'The last option standing.'
  }

  if (runoff.resolved_by === 'unresolved') {
    return `Genuinely tied: ${voters(runoff.prefers_a)} preferred each, on identical score totals.`
  }

  const placed = options[0].id
  const other = nameById.get(placed === finalists[0] ? finalists[1] : finalists[0]) ?? 'the other'
  const [won, lost] =
    placed === finalists[0]
      ? [runoff.prefers_a, runoff.prefers_b]
      : [runoff.prefers_b, runoff.prefers_a]

  if (runoff.resolved_by === 'higher_score') {
    return `Level with ${other} at ${voters(won)} each; placed above it on the higher score total.`
  }

  if (runoff.resolved_by === 'five_star_votes') {
    return `Level with ${other} at ${voters(won)} each and on score; placed above it on five-star votes.`
  }

  return `Preferred over ${other} by ${voters(won)} to ${lost}.`
}

/** A tie for this place's runoff slots, and what broke it. */
function tiebreakNote(tb: Tiebreak): string {
  const rule =
    tb.resolved_by === 'head_to_head'
      ? 'head-to-head preference'
      : tb.resolved_by === 'five_star_votes'
        ? 'five-star votes'
        : 'a random draw'

  return `${tb.tied.map((t) => t.name).join(' and ')} tied at ${tb.tied_at} pts for the runoff; ${tb.advanced
    .map((a) => a.name)
    .join(', ')} advanced on ${rule}.`
}
