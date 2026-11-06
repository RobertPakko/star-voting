import { useState, type ComponentProps } from 'react'
import { Button, Menu } from '@mantine/core'
import {
  CaretDownIcon,
  ChartPieSliceIcon,
  ListNumbersIcon,
  UsersThreeIcon,
} from '@phosphor-icons/react'
import { CHOICES, offers, type ResultTool } from '../lib/choices'
import type { PollKind, PollResults } from '../lib/types'
import { FullRanking } from './FullRanking'
import { MultipleWinners } from './MultipleWinners'
import { FractionalWinners } from './FractionalWinners'

type Tool = ResultTool

/**
 * The other answers the same ballots can give, as one menu in the result's
 * banner rather than a button each, so the banner keeps to the winner's name
 * and one control. Each item opens its own modal; which are offered is
 * decided by `offers` in lib/choices.ts. The result the page already draws
 * (the question's kind, `shown`) is not offered again. `/choices` is the
 * page that explains all three.
 */
export function MoreResults({
  source,
  results,
  shown = 'option',
}: {
  source: ComponentProps<typeof FullRanking>['source']
  /** Already relabelled by Results on a time poll; see relabelResults. */
  results: PollResults
  /** The result on the page, left off the menu. */
  shown?: PollKind
}) {
  const [open, setOpen] = useState<Tool | null>(null)
  const close = () => setOpen(null)
  const offered = (tool: Tool) => tool !== shown && offers(tool, results)

  const items = [
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
    </>
  )
}
