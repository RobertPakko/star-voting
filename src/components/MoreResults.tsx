import { useState, type ComponentProps } from 'react'
import { Button, Menu } from '@mantine/core'
import {
  CaretDownIcon,
  ChartPieSliceIcon,
  CoinsIcon,
  HandshakeIcon,
  ListNumbersIcon,
  ArrowsSplitIcon,
  TrophyIcon,
  UsersThreeIcon,
} from '@phosphor-icons/react'
import { CHOICES, offers, toolLabel, type ResultTool } from '../lib/choices'
import type { PollResults } from '../lib/types'
import { BestOption } from './BestOption'
import { FullRanking } from './FullRanking'
import { MultipleWinners } from './MultipleWinners'
import { FractionalWinners } from './FractionalWinners'
import { Consensus } from './Consensus'
import { ProportionalBudget } from './ProportionalBudget'
import { OptionAssignment } from './OptionAssignment'
import { isSampleId } from '../lib/samplePoll'

type Tool = ResultTool

/**
 * The other answers the same ballots can give, as one menu in the result's
 * banner rather than a button each, so the banner keeps to the winner's name
 * and one control. Each item opens its own modal; which are offered is
 * decided by `offers` in lib/choices.ts. The result the page already draws
 * (the question's kind, `shown`) is not offered again. `/choices` is the
 * page that explains them all.
 */
export function MoreResults({
  source,
  results,
  shown,
}: {
  source: ComponentProps<typeof FullRanking>['source']
  /** Already relabelled by Results on a time poll; see relabelResults. */
  results: PollResults
  /** The result on the page, left off the menu: `option` where it is STAR's winner. */
  shown: Tool
}) {
  // The sample answers from a recording, which holds no budget or assignment
  // for a question that did not ask for one.
  const offered = (tool: Tool) =>
    tool !== shown &&
    offers(tool, results) &&
    !((tool === 'budget' || tool === 'assignment') && isSampleId(source.pollId))
  const [open, setOpen] = useState<Tool | null>(null)
  const close = () => setOpen(null)

  const items = [
    offered('option') && {
      tool: 'option' as const,
      label: toolLabel('option', results.kind),
      icon: TrophyIcon,
    },
    offered('consensus') && {
      tool: 'consensus' as const,
      label: toolLabel('consensus', results.kind),
      icon: HandshakeIcon,
    },
    offered('ranking') && {
      tool: 'ranking' as const,
      label: CHOICES.ranking.label,
      icon: ListNumbersIcon,
    },
    offered('multiple') && {
      tool: 'multiple' as const,
      label: CHOICES.multiple.label,
      icon: UsersThreeIcon,
    },
    offered('fractional') && {
      tool: 'fractional' as const,
      label: CHOICES.fractional.label,
      icon: ChartPieSliceIcon,
    },
    offered('budget') && {
      tool: 'budget' as const,
      label: CHOICES.budget.label,
      icon: CoinsIcon,
    },
    offered('assignment') && {
      tool: 'assignment' as const,
      label: CHOICES.assignment.label,
      icon: ArrowsSplitIcon,
    },
  ].filter((item) => item !== false)

  if (items.length === 0) return null

  return (
    <>
      <Menu position="bottom-end" withinPortal>
        <Menu.Target>
          <Button
            variant="default"
            size="compact-sm"
            rightSection={<CaretDownIcon size={14} aria-hidden />}
          >
            More results
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          {items.map(({ tool, label, icon: Icon }) => (
            <Menu.Item
              key={tool}
              leftSection={<Icon size={16} aria-hidden />}
              onClick={() => setOpen(tool)}
            >
              {label}
            </Menu.Item>
          ))}
        </Menu.Dropdown>
      </Menu>

      {offered('option') && (
        <BestOption source={source} results={results} opened={open === 'option'} onClose={close} />
      )}
      {offered('consensus') && (
        <Consensus
          source={source}
          results={results}
          opened={open === 'consensus'}
          onClose={close}
        />
      )}
      {offered('ranking') && (
        <FullRanking
          source={source}
          results={results}
          opened={open === 'ranking'}
          onClose={close}
        />
      )}
      {offered('multiple') && (
        <MultipleWinners
          source={source}
          results={results}
          opened={open === 'multiple'}
          onClose={close}
        />
      )}
      {offered('fractional') && (
        <FractionalWinners
          source={source}
          results={results}
          opened={open === 'fractional'}
          onClose={close}
        />
      )}
      {offered('budget') && (
        <ProportionalBudget
          source={source}
          results={results}
          opened={open === 'budget'}
          onClose={close}
        />
      )}
      {offered('assignment') && (
        <OptionAssignment
          source={source}
          results={results}
          opened={open === 'assignment'}
          onClose={close}
        />
      )}
    </>
  )
}
