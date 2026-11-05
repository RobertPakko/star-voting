import { useState, type ComponentProps } from 'react'
import { Button, Menu } from '@mantine/core'
import {
  CaretDownIcon,
  ChartPieSliceIcon,
  ListNumbersIcon,
  UsersThreeIcon,
} from '@phosphor-icons/react'
import type { PollResults } from '../lib/types'
import { FullRanking } from './FullRanking'
import { MultipleWinners } from './MultipleWinners'
import { FractionalWinners } from './FractionalWinners'

type Tool = 'ranking' | 'multiple' | 'fractional'

/*
 * Which tools a tally is offered, from the option count it already carries,
 * so the menu never waits on a request to find out. With two options the
 * ranking is the winner and the option it beat, both on screen, and choosing
 * more than one winner is choosing both; how to split between two is still a
 * question.
 */
const offersFullRanking = (results: PollResults) => results.options.length >= 3
const offersMultipleWinners = (results: PollResults) => results.options.length >= 3
const offersFractionalWinners = (results: PollResults) => results.options.length >= 2

/**
 * The other answers the same ballots can give, as one menu in the result's
 * banner rather than a button each, so the banner keeps to the winner's name
 * and one control. Each item opens its own modal; which are offered is
 * decided here (`offers…`). `/extensions` is the page that explains all three.
 */
export function MoreResults({
  source,
  results,
}: {
  source: ComponentProps<typeof FullRanking>['source']
  /** Already relabelled by Results on a time poll; see relabelResults. */
  results: PollResults
}) {
  const [open, setOpen] = useState<Tool | null>(null)
  const close = () => setOpen(null)

  const items = [
    offersFullRanking(results) && {
      tool: 'ranking' as const,
      label: 'Full ranking',
      icon: ListNumbersIcon,
    },
    offersMultipleWinners(results) && {
      tool: 'multiple' as const,
      label: 'Multiple winners',
      icon: UsersThreeIcon,
    },
    offersFractionalWinners(results) && {
      tool: 'fractional' as const,
      label: 'Fractional winners',
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

      {offersFullRanking(results) && (
        <FullRanking
          source={source}
          results={results}
          opened={open === 'ranking'}
          onClose={close}
        />
      )}
      <MultipleWinners opened={open === 'multiple'} onClose={close} />
      <FractionalWinners opened={open === 'fractional'} onClose={close} />
    </>
  )
}
