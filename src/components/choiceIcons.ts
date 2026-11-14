import type { MantineColor } from '@mantine/core'
import {
  ArrowsSplitIcon,
  ChartPieSliceIcon,
  CirclesThreeIcon,
  HandshakeIcon,
  ListNumbersIcon,
  RankingIcon,
  TrophyIcon,
  type Icon,
} from '@phosphor-icons/react'
import type { Choice } from '../lib/choices'

/**
 * Each choice's icon and colour, as its section on `/choices` draws it and
 * the choice guide's answer repeats it. A different colour per choice, so the
 * folded list is easy to scan.
 */
export const CHOICE_ICONS: Record<Choice, { icon: Icon; color: MantineColor }> = {
  option: { icon: TrophyIcon, color: 'yellow' },
  consensus: { icon: HandshakeIcon, color: 'teal' },
  ranking: { icon: ListNumbersIcon, color: 'blue' },
  multiple: { icon: RankingIcon, color: 'violet' },
  consensus_winners: { icon: CirclesThreeIcon, color: 'cyan' },
  fractional: { icon: ChartPieSliceIcon, color: 'grape' },
  assignment: { icon: ArrowsSplitIcon, color: 'orange' },
}
