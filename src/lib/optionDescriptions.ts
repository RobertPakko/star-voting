import { createContext, useContext } from 'react'

/**
 * Every option's description on the question whose results are on screen, by
 * option id, so each result's body can put the same info mark beside an
 * option's name (`OptionNote`) without the description riding on every count
 * the database answers. `Results` provides it from the option list the page
 * already holds.
 */
export const OptionDescriptions = createContext<ReadonlyMap<string, string>>(new Map())

/** The description of option `id`, if the question has one for it. */
export const useOptionDescription = (id: string): string | null =>
  useContext(OptionDescriptions).get(id) ?? null
