import { describe, expect, test } from 'vitest'
import {
  MAX_OPTIONS,
  MAX_QUESTIONS,
  OPTION_DESCRIPTION_MAX,
  OPTION_NAME_MAX,
  POLL_DESCRIPTION_MAX,
  TITLE_MAX,
  VOTER_NAME_MAX,
} from './limits'

/**
 * That every number in `limits.ts` is the number the database actually
 * enforces.
 *
 * This file exists because the drift it checks for has already happened once.
 * `0055_schedule_polls.sql` raised the option ceiling from 50 to 500 in
 * `insert_option` and `insert_poll_row`, and `MAX_OPTIONS` was left at 50 --
 * so the create form refused a 210-window calendar the database would have
 * accepted, and the commit that did it claimed both had been changed. Nothing
 * caught it: the SQL suite cannot see TypeScript, the type checker cannot see
 * SQL, and the two numbers are four directories apart.
 *
 * `limits.ts` states the rule in its own header -- *change a number here and
 * change it there in the same breath; the two disagreeing is a field the form
 * accepts and the server rejects* -- and a rule with nothing enforcing it is a
 * comment. This is the enforcement.
 *
 * **It reads the migrations rather than a copy of them**, in filename order,
 * and takes the *last* definition of each function, because that is what a
 * database built from them ends up running. A migration that changes a limit
 * therefore fails this test until `limits.ts` is changed too, which is the
 * moment the two are supposed to move together.
 *
 * The failure it prevents is quiet in both directions. A form stricter than
 * the database refuses work the server would have taken; a form looser than
 * the database sends work the server refuses, and the reader gets a raised
 * exception where they should have got a field going red.
 */

/**
 * The migrations, read through Vite's own glob rather than through `node:fs`.
 *
 * Everything under `src/` is compiled by `tsconfig.app.json`, which types the
 * browser and deliberately does not type Node -- so that app code cannot
 * reach for a filesystem it will not have. A test living beside the module it
 * tests is held to the same rule, and `import.meta.glob` is the way in that
 * does not require relaxing it: Vite inlines the files at build time, `?raw`
 * hands them over as strings, and nothing here needs to run outside a bundler.
 */
const FILES: Record<string, string> = import.meta.glob('../../supabase/migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
})

/** Every migration, in the order a database applies them. */
function migrations(): string {
  return Object.keys(FILES)
    .sort()
    .map((path) => FILES[path])
    .join('\n')
}

/**
 * The last definition of one function across all the migrations -- which is
 * the one that survives, since each `create or replace` replaces the last.
 */
function definitionOf(name: string): string {
  const all = migrations()
  const pattern = new RegExp(
    `create or replace function\\s+"public"\\."${name}"[\\s\\S]*?\\n\\$\\$;`,
    'gi',
  )
  const found = all.match(pattern)
  if (!found?.length) throw new Error(`no definition of ${name} in supabase/migrations`)
  return found[found.length - 1]
}

/**
 * The number a guard in that function compares against. `what` is a fragment
 * of the comparison as it is written, so a rewritten guard fails loudly here
 * rather than matching something else by accident.
 */
function guard(fn: string, what: string): number {
  const body = definitionOf(fn)
  const match = new RegExp(`${what}\\s*(\\d+)`).exec(body)
  if (!match) throw new Error(`no guard matching /${what}/ in ${fn}`)
  return Number(match[1])
}

describe('the form and the database agree about', () => {
  test('how long a title may be', () => {
    expect(guard('insert_poll_row', 'length\\(p_title\\) >')).toBe(TITLE_MAX)
    // A question's own title, bounded where the loop can still name which
    // question is wrong. Same ceiling, different function.
    expect(guard('create_poll_group', 'length\\(v_question_title\\) >')).toBe(TITLE_MAX)
  })

  test('how long a description may be', () => {
    expect(guard('insert_poll_row', 'length\\(p_description\\) >')).toBe(POLL_DESCRIPTION_MAX)
  })

  test("how long an option's name and description may be", () => {
    expect(guard('insert_option', 'length\\(v_name\\) >')).toBe(OPTION_NAME_MAX)
    expect(guard('insert_option', 'length\\(v_description\\) >')).toBe(OPTION_DESCRIPTION_MAX)
  })

  test('how many options a ballot may hold', () => {
    // Both doors, because a cap enforced on one of two is a cap on nothing:
    // insert_option is the suggestion and creator paths, insert_poll_row is
    // creation. This is the pair that drifted.
    expect(guard('insert_option', 'v_count >=')).toBe(MAX_OPTIONS)
    expect(guard('insert_poll_row', 'jsonb_array_length\\(v_opts\\) >')).toBe(MAX_OPTIONS)
  })

  test('how many questions a poll may ask', () => {
    expect(guard('create_poll_group', 'v_count >')).toBe(MAX_QUESTIONS)
  })

  test('how long a voter may name themselves', () => {
    expect(guard('open_poll_submit', 'length\\(v_name\\) >')).toBe(VOTER_NAME_MAX)
  })
})

describe('the check itself', () => {
  // A test that silently matches nothing passes forever. These two prove the
  // reader above is actually reading something.
  test('finds the function it is looking for, and fails when there is none', () => {
    expect(definitionOf('insert_option')).toContain('v_count >=')
    expect(() => definitionOf('no_such_function')).toThrow(/no definition/)
  })

  test('and fails when the guard it wants is gone', () => {
    expect(() => guard('insert_option', 'v_count <=')).toThrow(/no guard matching/)
  })

  test('reads the last definition, not the first', () => {
    // 0053 defines insert_option with a ceiling of 50 and 0055 replaces it
    // with 500; a reader taking the first match would report 50 and this whole
    // file would pass while asserting the opposite of what it means to.
    expect(guard('insert_option', 'v_count >=')).toBeGreaterThan(50)
  })
})
