import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  ActionIcon,
  Button,
  Card,
  Divider,
  Group,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core'
import { PencilSimpleIcon } from '@phosphor-icons/react'
import { notifications } from '@mantine/notifications'
import { supabase } from '../lib/supabase'
import { PaintTimes } from './PaintTimes'
import type { PaintedEdit } from './PaintTimes'
import { openPollRpc } from '../lib/samplePoll'
import { MAX_OPTIONS, OPTION_DESCRIPTION_MAX, OPTION_NAME_MAX, tooLong } from '../lib/limits'
import { voterKeyFor } from '../lib/voterKey'
import type { VoterName } from '../lib/voterName'
import { DescriptionField } from './DescriptionField'
import { NameRoster } from './NameRoster'
import { OptionDescription } from './OptionDescription'
import listRow from './listRow.module.css'
import { OpeningNote } from './PollNotices'
import { VoterNameField } from './VoterNameField'
import type { PollOption, PollSchedule } from '../lib/types'

/**
 * Which endpoint an added option goes through.
 *
 * The first two are the suggestion path, and are the same split as
 * ResultsSource and BallotsSource for the same reason: a session proves the
 * caller belongs to an invite poll, the link proves it for an open
 * one. `creator` is the other path entirely; the poll's own creator
 * correcting a list that is already a ballot, on a poll nobody has voted in
 * yet. See 0028_creator_edits_options.sql for why that is allowed and where
 * the window closes.
 *
 * Confirming takes the same two ways in, so it takes the same value: the
 * creator's correction is the one that cannot be confirmed, because a list
 * that is already a ballot has nobody left to be done adding to it.
 */
/** Only has to be unique within one open card, and never leaves it. */
let draftSeq = 0

/** An option this reader is typing and has not sent. */
type Draft = { key: string; name: string; description: string }

function blankDraft(): Draft {
  draftSeq += 1
  return { key: `draft-${draftSeq}`, name: '', description: '' }
}

/** A field nobody has typed into, which is room for an option and not one. */
function isBlank(d: Draft): boolean {
  return !d.name.trim() && !d.description.trim()
}

/**
 * What is wrong with an option somebody has typed, and which of its two
 * fields it is wrong in -- so the message lands on that field rather than as
 * a line of red under the whole card.
 */
type Problem = { field: 'name' | 'description'; message: string }

export type OptionsSource =
  | { kind: 'poll'; pollId: string }
  | { kind: 'open'; pollId: string }
  | { kind: 'creator'; pollId: string }

/**
 * The unsaved edit a list is holding, left where the card around it can apply
 * it.
 *
 * Confirming the options is one act -- *this list, the one in front of me, is
 * the one I mean* -- and it used to be two: save the windows you painted, or
 * add the option you typed, and then say you were done with the list they
 * went into. So the list writes what it is holding into this hole, and
 * *Confirm options* puts it in before it confirms anything. It answers
 * whether the save went through; the list has already said what was wrong
 * with it, against the field or under the list, where the reader was looking.
 *
 * Null whenever there is nothing outstanding, which is what makes a
 * confirmation with no edits behind it a single request as it always was.
 */
export type DraftHold = { current: (() => Promise<boolean>) | null }

/**
 * How this reader says they are done with the list, when they have a say in
 * it at all. Absent for the creator correcting a ballot's options, and for an
 * invite poll's creator who did not invite themselves — their "I am done" is
 * *Open poll*, which they have had all along.
 */
export interface Confirmation {
  /** Whether they have already said so; the card draws either way. */
  confirmed: boolean
  /**
   * Whether this press could be the press that opens the poll — a poll with a
   * participant list, still waiting on somebody. The one thing about the
   * button that is not obvious from the button.
   *
   * **How many have confirmed is deliberately not here**; that is the count
   * badge's job. It is false once everybody has confirmed, which is a poll
   * that stayed put for a reason this card cannot name — a question of the
   * group nobody has finished, or a list still short of two options — so it
   * says the creator ends the stage rather than promising an opening that has
   * already not happened.
   */
  opensWhenEveryoneHas?: boolean
}

/**
 * The option-collecting stage as one person sees it, laid out as the ballot
 * that replaces it: name at the top, the poll's other questions under it, the
 * thing being filled in, and what happens next beside the button that ends
 * your part in it.
 *
 * Collecting options is the ballot's stage, at the same address and in the
 * same place on the page, so the two cards are built the same way round rather
 * than each in whatever order it grew in.
 *
 * It stands in for the ballot on two occasions, and they are not the same:
 *
 *  - a poll **still collecting** its options, which has no ballot yet.
 *    Everyone in the poll sees this list and this box, the creator included,
 *    who suggests through the same RPC as everybody else — one code path, and
 *    no way for the creator's list to be built under rules nobody else's is.
 *  - a poll whose creator is **correcting** a list that is already a ballot,
 *    which only they see and only while nobody has voted. That path is
 *    `source.kind === 'creator'`. It confirms nothing and carries its own way
 *    out, as `footer`.
 *
 * **Both of them draft.** Every edit a reader makes to the list — an option
 * typed, a row corrected, a row struck out — waits in the browser until the
 * press that ends the card applies it, and that is one press and one save
 * whichever of the two occasions this is. The suggestion paths used to send
 * each edit as it was made, on the grounds that the list belongs to the group
 * and everybody watching should see a suggestion land as it lands; what that
 * actually bought was a card whose *Confirm options* meant something
 * different from the *Done* three lines of code away, four round trips for
 * four typed options, and no way to change your mind about any of them. See
 * `saveDraft` for the doors the one save goes through.
 *
 * Suggestions carry no name: who suggested what would be a third disclosure
 * question on top of "who responded" and "how they voted", and the poll's tags
 * answer neither about the option list. The name field at the top is the
 * *confirmation's*, on the one poll with no account to read one from.
 *
 * Pruning is creator-only and sits beside the list it acts on. Opening the
 * poll does not: that is what the creator does to the *poll*, so it lives in
 * `CreatorControls` with the rest of the lifecycle.
 */
export function CollectOptions({
  source,
  options,
  schedule,
  isCreator,
  voterName,
  questionStrip,
  done,
  confirm,
  onChanged,
  onConfirmed,
}: {
  source: OptionsSource
  options: PollOption[]
  /**
   * The grid, on a poll that finds a time; null on every other poll.
   *
   * Its presence is what swaps the text box and the row-per-suggestion for a
   * calendar: the list a time poll is collecting is a list of window starts,
   * and nobody types one of those. Everything around it -- the name field, the
   * question strip, the confirmation, the roster -- is the same card either
   * way, because being done adding is the same act whichever the list is.
   */
  schedule?: PollSchedule | null
  isCreator: boolean
  /**
   * The name to confirm under, when the poll has to ask for one: an open poll
   * that shows its respondents, and nothing else. `open_poll_confirm_options`
   * applies exactly this rule and discards a name on a poll that hides them,
   * so an invite poll — which reads the name off the account — is handed
   * none and draws no field. Held by the page rather than here; see
   * VoterNameField for why the name outlives the card asking for it.
   */
  voterName?: VoterName
  /** Navigation for a multi-question poll, rendered inside the card as on the ballot. */
  questionStrip?: ReactNode
  /**
   * The way out of the creator's correction, on the one path with nothing to
   * confirm.
   *
   * One press, as *Confirm options* is on every other path: whatever the list
   * is holding goes in, and only a save that went through leaves the editor.
   * It used to be two buttons -- *Save changes* and then *Done* -- for what is
   * one intention, and a reader who pressed only the second lost the edit. See
   * DraftHold.
   */
  done?: {
    /** Said beside the button; the page's situation rather than the list's. */
    note?: ReactNode
    /** Leave the editor, once there is nothing outstanding to leave behind. */
    onDone: () => void
  }
  /** How this reader says they are done adding; see `Confirmation`. */
  confirm?: Confirmation
  /** An option arrived or left, or a confirmation moved: re-read the poll. */
  onChanged: () => void
  /**
   * A *first* confirmation went in, as against one taken back. Offered so a
   * poll of several questions can move on to the next list this reader still
   * owes, which is the whole of what they do next — exactly as a first ballot
   * moves them on. It **replaces** `onChanged` on that path: the page that
   * takes this is leaving the question, and a re-read of the question being
   * left would land after the next one had loaded.
   */
  onConfirmed?: () => void
}) {
  const [busy, setBusy] = useState(false)
  // A request that failed, which is about the poll rather than about the
  // field: what is wrong with the name is marked on the box it was typed in,
  // by the field itself.
  const [error, setError] = useState<string | null>(null)
  // And what to do about it when this reader says they are done. See
  // DraftHold: the list fills it in, `confirmOptions` empties it.
  const draft = useRef<(() => Promise<boolean>) | null>(null)

  // The name is what a confirmation is given under, so it is asked for only
  // where there is something to confirm: the creator correcting a ballot's
  // options confirms nothing and is handed no name to do it under.
  const nameField = confirm && voterName ? <VoterNameField name={voterName} /> : null

  async function confirmOptions() {
    if (busy || !confirm) return
    setError(null)

    if (voterName && !voterName.check('Enter your name so the group can see who has confirmed.')) {
      return
    }

    setBusy(true)

    // Whatever the list is holding goes in first, because that is what is
    // being confirmed: an option typed into the box and not yet added, a row
    // struck out, an afternoon painted on the calendar. All of it is part of
    // the list this reader is saying they are happy with, and saving it and
    // then saying so were two presses of two buttons for one intention. The
    // list reports its own failure, so this only has to stop.
    const save = draft.current
    if (save && !(await save())) {
      setBusy(false)
      return
    }

    const { error: rpcError } = await sendConfirmation(source, voterName?.trimmed ?? null)
    setBusy(false)

    if (rpcError) {
      setError(rpcError.message)
      // The list went in and the confirmation did not, so the poll has moved
      // and this card is drawing it one read out of date: the rows that were
      // drafts are on the poll now, and the draft they were held in is gone.
      // Without this the reader would see their own additions missing under a
      // refusal, which reads as the whole press having failed rather than the
      // half of it that did.
      if (save) onChanged()
      return
    }
    // Remembered only once a confirmation has actually gone in under it, so a
    // name the server refused is not offered back on the next poll.
    voterName?.remember()
    notifications.show({ message: 'Options confirmed', color: 'green' })
    ;(onConfirmed ?? onChanged)()
  }

  /**
   * The way out of the creator's correction: put in whatever the list is
   * holding, and leave only if it went in.
   *
   * The same shape as `confirmOptions`, and for the same reason -- an option
   * typed into the box, or an afternoon painted on the calendar, is part of
   * the list this reader means. The list reports its own failure, so a save
   * that did not go through only has to keep the editor open, with the edit
   * still in it.
   */
  async function finishEditing() {
    if (busy || !done) return
    setError(null)

    const save = draft.current
    if (save) {
      setBusy(true)
      const saved = await save()
      setBusy(false)
      if (!saved) return
      // The quiet save says nothing and re-reads nothing; the page behind this
      // editor is about to draw the list that was just saved.
      onChanged()
    }
    done.onDone()
  }

  async function reopenList() {
    if (busy) return
    setError(null)
    setBusy(true)
    const { error: rpcError } = await withdrawConfirmation(source)
    setBusy(false)

    if (rpcError) {
      setError(rpcError.message)
      return
    }
    // No notification: the card in front of them becoming the list again is
    // the whole of what happened, and says so better than a message would.
    onChanged()
  }

  // Done adding, and back to the list whenever they are not. The same pair as
  // the ballot's "your vote is in" and the *Edit vote* behind it, and the same
  // window: a confirmation can be taken back for exactly as long as it can be
  // given, which is for as long as the poll is still collecting. The database
  // draws that line in `assert_collecting_options`; this card is only ever
  // rendered inside it.
  if (confirm?.confirmed) {
    return (
      <Card withBorder>
        <Stack gap="sm">
          {questionStrip}
          <Stack gap={2}>
            <Text fw={500}>You’ve confirmed the options</Text>
            <Group justify="space-between" wrap="wrap" gap="sm">
              <OpeningNote
                isCreator={isCreator}
                whenEveryoneHas={confirm.opensWhenEveryoneHas}
                canAdd
              />
              <Button
                variant="light"
                onClick={reopenList}
                loading={busy}
                style={{ marginLeft: 'auto' }}
              >
                Edit options
              </Button>
            </Group>
            {error && (
              <Text c="red" size="sm">
                {error}
              </Text>
            )}
          </Stack>
        </Stack>
      </Card>
    )
  }

  /**
   * The foot of the card: the button that ends it, what happens next, and --
   * on a list, not a calendar -- the list's *Add option* beside that button,
   * which is where somebody looking for "one more" looks. Drawn by the list,
   * below its fields, so the button can sit here and still act on them.
   */
  function footer(addButton: ReactNode) {
    return (
      <>
        {error && (
          <Text c="red" size="sm">
            {error}
          </Text>
        )}

        {/* The line is what stops the fields and the buttons that end the
            card reading as one block. The ballot rules its footer off the same
            way, off the last option's divider. */}
        {(confirm || done) && <Divider />}

        {confirm ? (
          <Group justify="space-between" wrap="wrap" gap="sm" align="flex-end">
            <Text size="sm" c="dimmed">
              Confirm the options once you have nothing more to add.
              <br />
              {confirm.opensWhenEveryoneHas ? (
                <>The poll opens for voting once everyone confirms.</>
              ) : (
                <>
                  {isCreator
                    ? 'Voting starts once you open the poll.'
                    : 'Voting starts once the poll’s creator opens the poll.'}
                </>
              )}
            </Text>
            <Group gap="xs" wrap="nowrap" style={{ marginLeft: 'auto' }}>
              {addButton}
              <Button onClick={confirmOptions} loading={busy}>
                Confirm options
              </Button>
            </Group>
          </Group>
        ) : (
          done && (
            <Group justify="space-between" wrap="wrap" gap="sm">
              {done.note && (
                <Text size="sm" c="dimmed" style={{ flex: 1, minWidth: 200 }}>
                  {done.note}
                </Text>
              )}
              <Group gap="xs" wrap="nowrap" style={{ marginLeft: 'auto' }}>
                {addButton}
                <Button variant="light" onClick={finishEditing} loading={busy}>
                  Done
                </Button>
              </Group>
            </Group>
          )
        )}
      </>
    )
  }

  return (
    <Card withBorder>
      <Stack gap="sm">
        {nameField}
        {questionStrip}

        {schedule ? (
          <>
            <TimeList
              source={source}
              options={options}
              schedule={schedule}
              isCreator={isCreator}
              // Wherever this card ends in a button -- *Confirm options*, or
              // the *Done* that leaves a correction -- that button is the save;
              // see DraftHold. The calendar keeps a save of its own only where
              // the card ends in neither, which is the creator of a soliciting
              // poll who did not invite themselves, because there it is the
              // only way the painting reaches the poll at all.
              ownSave={!confirm && !done}
              draft={draft}
              onChanged={onChanged}
            />
            {footer(null)}
          </>
        ) : (
          <OptionList
            source={source}
            options={options}
            isCreator={isCreator}
            // The same rule the calendar beside it answers to: wherever this
            // card ends in a button, that button is the save. The list keeps
            // one of its own only where the card ends in neither *Confirm
            // options* nor *Done*, which is the creator of a soliciting
            // invite poll who did not invite themselves — they confirm
            // nothing, and without it the list would have no way to reach the
            // poll at all.
            ownSave={!confirm && !done}
            draft={draft}
            footer={footer}
            onChanged={onChanged}
          />
        )}
      </Stack>
    </Card>
  )
}

/** Saying you are done, by whichever of the two identities the poll has. */
function sendConfirmation(source: OptionsSource, voterName: string | null) {
  return source.kind === 'poll'
    ? supabase.rpc('confirm_options', { p_poll_id: source.pollId })
    : openPollRpc('open_poll_confirm_options', {
        p_poll_id: source.pollId,
        p_voter_key: voterKeyFor(source.pollId),
        p_voter_name: voterName,
      })
}

/** And taking it back, which the same two functions allow on the same terms. */
function withdrawConfirmation(source: OptionsSource) {
  return source.kind === 'poll'
    ? supabase.rpc('unconfirm_options', { p_poll_id: source.pollId })
    : openPollRpc('open_poll_unconfirm_options', {
        p_poll_id: source.pollId,
        p_voter_key: voterKeyFor(source.pollId),
      })
}

/**
 * The list itself, and the fields that add to it.
 *
 * Split from the card around it because they answer to different people: this
 * is the poll's list, which everybody in the poll writes, and the card is one
 * reader's part in it. Keeping the two apart is also what keeps a suggestion
 * being typed clear of the name a confirmation is given under — two fields,
 * two states, two things that can be wrong, and no way for one to clear the
 * other's message.
 */
function OptionList({
  source,
  options,
  isCreator,
  ownSave,
  draft,
  footer,
  onChanged,
}: {
  source: OptionsSource
  options: PollOption[]
  isCreator: boolean
  /**
   * Whether the list carries its own *Save options*; see CollectOptions.
   *
   * False wherever the card around it ends in a button of its own, which is
   * nearly everywhere: that press is the same press, and two buttons for one
   * act is the thing that was wrong.
   */
  ownSave: boolean
  /**
   * Where the edit this list is holding goes: *Confirm options* on the
   * suggestion paths, *Done* on the creator's correction, and `ownSave` on
   * the one path that ends in neither. See DraftHold.
   */
  draft: DraftHold
  /**
   * The foot of the card, drawn by the card and handed the list's *Add
   * option* to put beside its own button. Absent on the `ownSave` path,
   * where the list draws its own foot.
   */
  footer?: (addButton: ReactNode) => ReactNode
  onChanged: () => void
}) {
  /**
   * Whether this list is already a ballot, which is the creator's correction
   * (`source.kind === 'creator'`) and nothing else.
   *
   * All it decides here is whether the two-option floor applies: a list still
   * being collected has none, because `finalize_options` applies it when the
   * list becomes a ballot. Which doors the save goes through is the same
   * question asked one layer down, in `sendDraft`.
   *
   * What it no longer decides is *when* anything is saved. Every path drafts;
   * see CollectOptions.
   */
  const correcting = source.kind === 'creator'

  /**
   * The options this reader is suggesting, as the fields they are typing them
   * into. There is no *Add* between typing an option and it being on the list:
   * there was, and people pressed it, saw a row drawn like every other row, and
   * took it for an option the poll now held when nothing had left the browser.
   * So what is typed stays a field until the press that ends the card puts it
   * in. See DraftHold.
   *
   * One blank field to start with, and *Add option* beside the button that
   * ends the card for each one after. It used to open the next field by
   * itself as soon as the last one was typed into, and a field appearing
   * under your typing is a field you did not ask for. A blank field is room,
   * not an option, and is never sent.
   */
  const [drafts, setDrafts] = useState<Draft[]>(() => [blankDraft()])
  /** What is wrong with each draft, by key, marked on the field it is about. */
  const [draftProblems, setDraftProblems] = useState<ReadonlyMap<string, Problem>>(new Map())
  /** The draft *Add option* just opened, which takes the cursor. */
  const [focusKey, setFocusKey] = useState<string | null>(null)
  /**
   * Rows already on the poll whose fields are open, by option id, and what is
   * in them.
   *
   * The pencil turns a row into its two fields and that is all it does: there
   * is no *Save* on the row, because a *Save* beside one option reads as a
   * save to the poll when it was only ever a save into the draft. What is in
   * the fields goes in with everything else on the press that ends the card,
   * and several rows may be open at once for the same reason several drafts
   * may be.
   *
   * A correction travels as a removal and an addition -- there is no update
   * door into `candidates`, and `creator_edit_options` applies its removals
   * before its additions, so a row keeping its name through an edit does not
   * collide with itself. The one visible cost is that the corrected option
   * arrives at the end of the list, where an added option goes. A row opened
   * and left as it was is not a correction and is not sent.
   */
  const [editing, setEditing] = useState<
    ReadonlyMap<string, { name: string; description: string }>
  >(new Map())
  /** What is wrong with each open row, on the field it is wrong in. */
  const [editProblems, setEditProblems] = useState<ReadonlyMap<string, Problem>>(new Map())
  // Rows on their way off the list, by id. Held rather than deleted for the
  // reason the additions are held: one press applies the whole list, and a
  // card where adding waits and removing does not is a card that has to be
  // explained. A row struck out while its fields are open keeps what was typed
  // in them, so *Keep* gives it back as the reader left it.
  const [dropping, setDropping] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const arriving = useArrivals(options)

  const filled = drafts.filter((d) => !isBlank(d))
  /** Open rows whose fields say something other than the option does. */
  const changed = options.filter((o) => {
    const e = editing.get(o.id)
    return (
      e &&
      !dropping.has(o.id) &&
      (e.name.trim() !== o.name || e.description.trim() !== (o.description ?? ''))
    )
  })
  // What the poll holds and keeps, before anything this reader is suggesting.
  const staying = options.length - dropping.size
  const kept = staying + filled.length
  const full = kept >= MAX_OPTIONS
  const dirty = filled.length > 0 || dropping.size > 0 || changed.length > 0
  // A list that is already a ballot cannot be pruned below what an election
  // needs; a list still being collected can, because `finalize_options`
  // applies the floor when it becomes a ballot. The trigger enforces both,
  // and this only decides whether to offer the button. See
  // 0028_creator_edits_options.sql.
  // Counted against what the save would leave behind rather than against what
  // is on the poll now, since three options with two of them struck through is
  // a list already at the floor.
  const atFloor = correcting && kept <= 2

  /**
   * Every name the list would hold if it were saved as it stands, apart from
   * one row -- the row being checked, which is not its own duplicate.
   *
   * Struck rows are counted, and counted under the name *Keep* would bring
   * them back under rather than the one the poll currently holds. A list that
   * let a name in because the row holding it was on its way out would have to
   * explain itself twice: once for accepting a name the list visibly holds,
   * and again when the way back has been quietly closed off behind it.
   * Correcting the option that holds the name is the answer to wanting the
   * name, and is a press away.
   *
   * The other side of that is the name a *renamed* struck row has let go of,
   * which is genuinely free -- and is why the save applies its removals
   * before its additions. See `sendDraft`.
   */
  function namesInUse(exceptKey?: string): string[] {
    // An open row counts as what is being typed into it rather than as what
    // it used to say: a name freed by a rename is a name this list is about
    // to want.
    const nameOf = (o: PollOption) => editing.get(o.id)?.name.trim() ?? o.name

    // Of the drafts, only the ones above the draft being checked: two drafts
    // holding one name mark the later of them, as the create form does, so
    // the earlier keeps the name and is not the one that has to change.
    const draftAt = drafts.findIndex((d) => d.key === exceptKey)
    const above = draftAt === -1 ? drafts : drafts.slice(0, draftAt)

    return [
      ...options.filter((o) => o.id !== exceptKey).map(nameOf),
      ...above.filter((d) => !isBlank(d)).map((d) => d.name.trim()),
    ]
  }

  /**
   * A name and a description, checked the way the database would check them
   * -- trimmed and handed back, or the reason one of them is wrong and which
   * one it is.
   *
   * The same rules `insert_option` applies, checked here so the one that
   * fails is marked on the field it failed in. The database is still what
   * decides, these cannot be trusted and are not relied on, and anything it
   * refuses for a reason not listed here still comes back as the error under
   * the card.
   *
   * Shared by the drafts and by the rows being corrected in place, which are
   * the same four questions asked of the same two fields. `adding` is the one
   * difference: a correction puts nothing new on the list, so the ceiling is
   * not its to meet. When it is set it is how many options the list would
   * hold with this one on it.
   */
  function checkOption(
    rawName: string,
    rawDescription: string,
    { adding, exceptKey }: { adding: number | false; exceptKey?: string },
  ): { name: string; description: string } | Problem {
    const trimmed = rawName.trim()
    const trimmedDescription = rawDescription.trim()

    if (!trimmed) return { field: 'name', message: 'Give the option a name.' }
    if (trimmed.length > OPTION_NAME_MAX)
      return { field: 'name', message: tooLong('An option name', trimmed.length, OPTION_NAME_MAX) }
    // Case-insensitive, like the database: two options differing only in
    // case are one option to everybody scoring the ballot.
    if (namesInUse(exceptKey).some((existing) => existing.toLowerCase() === trimmed.toLowerCase()))
      return { field: 'name', message: `“${trimmed}” is already on the list.` }
    if (trimmedDescription.length > OPTION_DESCRIPTION_MAX)
      return {
        field: 'description',
        message: tooLong('A description', trimmedDescription.length, OPTION_DESCRIPTION_MAX),
      }
    if (adding !== false && adding > MAX_OPTIONS)
      return {
        field: 'name',
        message: `This poll already holds the ${MAX_OPTIONS} options a ballot can.`,
      }

    return { name: trimmed, description: trimmedDescription }
  }

  /**
   * Everything this list is holding, checked: the options typed and the rows
   * corrected. Null if anything is wrong, with every problem marked on its
   * own field at once, so a press that fails says all of it rather than the
   * first.
   */
  function checkedDraft(): {
    added: { name: string; description: string }[]
    corrected: { key: string; name: string; description: string }[]
  } | null {
    setError(null)

    const addProblems = new Map<string, Problem>()
    const added: { name: string; description: string }[] = []
    for (const d of drafts) {
      if (isBlank(d)) continue
      const result = checkOption(d.name, d.description, {
        adding: staying + added.length + addProblems.size + 1,
        exceptKey: d.key,
      })
      if ('field' in result) addProblems.set(d.key, result)
      else added.push(result)
    }

    const fixProblems = new Map<string, Problem>()
    const corrected: { key: string; name: string; description: string }[] = []
    for (const o of changed) {
      const e = editing.get(o.id)!
      const result = checkOption(e.name, e.description, { adding: false, exceptKey: o.id })
      if ('field' in result) fixProblems.set(o.id, result)
      else corrected.push({ key: o.id, ...result })
    }

    setDraftProblems(addProblems)
    setEditProblems(fixProblems)
    return addProblems.size > 0 || fixProblems.size > 0 ? null : { added, corrected }
  }

  /** One of the drafts, changed, and its message cleared with it. */
  function changeDraft(key: string, fields: Partial<Omit<Draft, 'key'>>) {
    setDrafts((prev) => prev.map((d) => (d.key === key ? { ...d, ...fields } : d)))
    setDraftProblems((prev) => without(prev, key))
  }

  /** A fresh blank field at the foot of the drafts, with the cursor in it. */
  function addDraft() {
    const next = blankDraft()
    setDrafts((prev) => [...prev, next])
    setFocusKey(next.key)
  }

  /** Take one of the drafts back off. */
  function discardDraft(key: string) {
    setDrafts((prev) => prev.filter((d) => d.key !== key))
    setDraftProblems((prev) => without(prev, key))
  }

  /** Turn a row into its two fields, filled in with what it says now. */
  function openEditor(option: PollOption) {
    setEditing((prev) =>
      new Map(prev).set(option.id, { name: option.name, description: option.description ?? '' }),
    )
  }

  function changeEdit(id: string, fields: { name: string; description: string }) {
    setEditing((prev) => new Map(prev).set(id, fields))
    setEditProblems((prev) => without(prev, id))
  }

  /** Mark an option for removal, or take the marking back. */
  function toggleDropping(id: string) {
    setDropping((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    setEditProblems((prev) => without(prev, id))
  }

  /**
   * The whole draft -- what is going, what is coming and what has been
   * corrected -- in one press.
   *
   * `creator_edit_options` takes both halves and applies the floor to where
   * they land rather than to the list the edit passes through; see
   * 0059_editing_options_in_one_go.sql.
   *
   * A refusal leaves the draft intact, because it is still the whole of what
   * is left to do: nothing here clears state it has not been told went in.
   */
  async function saveEverything(): Promise<boolean> {
    if (busy) return false
    const checked = checkedDraft()
    if (!checked) return false
    const { added, corrected } = checked
    if (added.length === 0 && corrected.length === 0 && dropping.size === 0) return true

    setError(null)
    setBusy(true)
    const { error: rpcError } = await sendDraft(source, {
      added,
      corrected: corrected.map(({ name, description }) => ({ name, description })),
      removed: [...dropping, ...corrected.map((c) => c.key)],
    })
    setBusy(false)

    if (rpcError) {
      setError(rpcError.message)
      return false
    }
    setDrafts([blankDraft()])
    setDraftProblems(new Map())
    setDropping(new Set())
    setEditing(new Map())
    setEditProblems(new Map())
    // Nothing said and nothing re-read: this is nearly always a save made on
    // the way out of the card -- see DraftHold -- and the act it is part of
    // says so itself and re-reads the poll once, at the end. The one press
    // that is not part of anything, `saveOwn`, does both for itself.
    return true
  }

  /**
   * The same save, pressed on this list's own button rather than on the one
   * that ends the card; see `ownSave`.
   */
  async function saveOwn() {
    if (!(await saveEverything())) return
    notifications.show({ message: 'Options saved', color: 'green' })
    onChanged()
  }

  // What this list is holding that the poll does not, left where the card's
  // own button can apply it; see DraftHold. Written after every render rather
  // than once, because it closes over the draft as it is now, and taken back
  // on the way out so no card confirms a list it has stopped drawing.
  useEffect(() => {
    draft.current = dirty ? () => saveEverything() : null

    return () => {
      draft.current = null
    }
  })

  const addButton = (
    <Button variant="default" onClick={addDraft} disabled={full || busy}>
      Add option
    </Button>
  )

  return (
    <Stack gap="sm">
      {options.map((option) => {
        const struck = dropping.has(option.id)
        const open = editing.get(option.id)
        // The row as the save would leave it, which is what a struck row
        // shows too, since *Keep* gives that back.
        const shown = open ?? { name: option.name, description: option.description ?? '' }

        return (
          /* The row's own box, which is what opens and closes; see
             listRow.module.css. No leaving animation: a removal is a draft
             everywhere now, so a row never actually goes while this list is on
             screen. It is struck through where it stands and comes back with a
             press. */
          <div
            key={option.id}
            className={`${listRow.row} ${arriving.has(option.id) ? listRow.joining : ''}`}
          >
            <div className={`${listRow.content} ${listRow.stacked}`}>
              <Group justify="space-between" wrap="nowrap" gap="sm" align="flex-start">
                {open && !struck ? (
                  <OptionFields
                    value={open}
                    problem={editProblems.get(option.id) ?? null}
                    autoFocus
                    ariaLabel={`Name of ${option.name}`}
                    onChange={(fields) => changeEdit(option.id, fields)}
                  />
                ) : (
                  <div style={{ minWidth: 0 }}>
                    {/* Struck through rather than gone, while the removal is
                        still a draft. Name and description together, because
                        what is leaving is the option rather than what it is
                        called. */}
                    <Text
                      fw={500}
                      c={struck ? 'dimmed' : undefined}
                      td={struck ? 'line-through' : undefined}
                    >
                      {shown.name}
                    </Text>
                    {shown.description && (
                      <OptionDescription description={shown.description} struck={struck} />
                    )}
                  </div>
                )}
                {isCreator &&
                  (struck ? (
                    <Button
                      variant="subtle"
                      size="compact-xs"
                      onClick={() => toggleDropping(option.id)}
                    >
                      Keep
                    </Button>
                  ) : (
                    <Group gap={4} wrap="nowrap" mt={open ? 6 : 0}>
                      {/* The pencil turns the row into fields and goes: there
                          is nothing more for it to do once they are open. The
                          cross stays, so an option can still be taken off
                          altogether after its fields have been opened. */}
                      {!open && (
                        <ActionIcon
                          variant="subtle"
                          aria-label={`Edit ${option.name}`}
                          onClick={() => openEditor(option)}
                        >
                          <PencilSimpleIcon size={16} aria-hidden />
                        </ActionIcon>
                      )}
                      <Tooltip
                        label="A poll needs at least two options"
                        disabled={!atFloor}
                        withArrow
                      >
                        {/* The span is what a tooltip on a disabled button
                            needs: a disabled control fires no pointer events of
                            its own. */}
                        <span>
                          <ActionIcon
                            variant="subtle"
                            color="red"
                            disabled={atFloor}
                            aria-label={`Remove ${option.name}`}
                            onClick={() => toggleDropping(option.id)}
                          >
                            &times;
                          </ActionIcon>
                        </span>
                      </Tooltip>
                    </Group>
                  ))}
              </Group>
              <Divider />
            </div>
          </div>
        )
      })}

      {/* What this reader is suggesting, as the fields they typed it into.
          They stay fields until the press that ends the card puts them in. */}
      {drafts.map((d, i) => (
        <div key={d.key} className={`${listRow.row} ${i > 0 ? listRow.joining : ''}`}>
          <div className={listRow.content}>
            <Group gap="xs" align="flex-start" wrap="nowrap">
              <OptionFields
                value={d}
                problem={draftProblems.get(d.key) ?? null}
                autoFocus={d.key === focusKey}
                placeholder={
                  options.length === 0 && i === 0 ? 'Add an option' : 'Add another option'
                }
                ariaLabel="Option you are suggesting"
                onChange={(fields) => changeDraft(d.key, fields)}
              />
              <ActionIcon
                variant="subtle"
                color="red"
                mt={6}
                aria-label={`Discard ${d.name.trim() || 'this option'}`}
                onClick={() => discardDraft(d.key)}
              >
                &times;
              </ActionIcon>
            </Group>
          </div>
        </div>
      ))}

      {full && (
        <Text size="xs" c="dimmed">
          A ballot may only have {MAX_OPTIONS} options.
        </Text>
      )}

      {error && (
        <Text c="red" size="sm">
          {error}
        </Text>
      )}

      {/* The one path where the card around this list ends in no button of
          its own, so the list has to carry the save; see `ownSave`. Placed
          and worded like the calendar's *Save times*, because it is the same
          button doing the same job on the other kind of list. */}
      {ownSave ? (
        <Group justify="flex-end" gap="xs">
          {addButton}
          <Button onClick={saveOwn} loading={busy} disabled={!dirty}>
            Save options
          </Button>
        </Group>
      ) : (
        footer?.(addButton)
      )}
    </Stack>
  )
}

/** A map without one key, or the same map where it never had it. */
function without<V>(map: ReadonlyMap<string, V>, key: string): ReadonlyMap<string, V> {
  if (!map.has(key)) return map
  const next = new Map(map)
  next.delete(key)
  return next
}

/**
 * A whole draft, through the doors this reader actually has.
 *
 * The creator's correction to a list that is already a ballot is one request:
 * `creator_edit_options` takes both halves and applies the two-option floor to
 * where they land rather than to the states the edit passes through. A
 * correction needs no door of its own, there being no update into
 * `candidates` -- the removals go in before the additions and in the same
 * transaction, so an option corrected without being renamed is never two
 * options of that name. See 0059_editing_options_in_one_go.sql.
 *
 * A list still being **collected** is two doors rather than one, because two
 * different people are writing it and this is the one thing about the two
 * paths that really is different:
 *
 *  - **corrections and removals** are the creator's alone, which is what the
 *    list already offered only them, and go through the creator's own door.
 *    One transaction, for the reason above: a rename that was a delete and
 *    then an add could leave the option gone and not come back.
 *  - **suggestions** are everybody's, and go through the suggestion endpoint
 *    every reader in the poll shares -- the creator included, which is the
 *    point. There is no way for the creator's additions to be built under
 *    rules nobody else's is.
 *
 * Corrections go first, and both reasons are load-bearing. The 500-option
 * ceiling cannot be met part-way through a swap. And a name a removal frees is
 * free by the time anything could want it: the duplicate check counts a struck
 * row under the name it would come *back* under, so striking a renamed row
 * releases the name it currently holds on the poll, and a suggestion in the
 * same press may be that name.
 *
 * The plural suggestion endpoints **skip** a name the list already holds
 * rather than refusing it, which is the one rule they add over the singular
 * pair this used to call. It is the right rule for a press that means a
 * *list*: the only way to reach it is for somebody else to have suggested the
 * same name since this reader typed theirs, and there is nothing they could do
 * about being told so.
 */
function sendDraft(
  source: OptionsSource,
  draft: {
    /** Options this reader typed, which are suggestions wherever they are. */
    added: { name: string; description: string }[]
    /** Rows of the poll as they have been corrected; the creator's alone. */
    corrected: { name: string; description: string }[]
    /** And the ids they replace, along with the rows struck out outright. */
    removed: string[]
  },
) {
  // Null rather than '' where there is nothing to say, which is what the
  // column holds for an option with no description.
  const named = (options: { name: string; description: string }[]) =>
    options.map((o) => ({ name: o.name, description: o.description || null }))

  if (source.kind === 'creator')
    return supabase.rpc('creator_edit_options', {
      p_poll_id: source.pollId,
      p_options: named([...draft.corrected, ...draft.added]),
      p_remove: draft.removed,
    })

  return applyToCollecting(source, {
    corrected: named(draft.corrected),
    removed: draft.removed,
    added: named(draft.added),
  })
}

/** The two halves above, in order, on a list still being collected. */
async function applyToCollecting(
  source: Exclude<OptionsSource, { kind: 'creator' }>,
  draft: {
    corrected: { name: string; description: string | null }[]
    removed: string[]
    added: { name: string; description: string | null }[]
  },
) {
  if (draft.corrected.length > 0 || draft.removed.length > 0) {
    const { error } = await supabase.rpc('creator_edit_options', {
      p_poll_id: source.pollId,
      p_options: draft.corrected,
      p_remove: draft.removed,
    })
    if (error) return { error }
  }

  if (draft.added.length === 0) return { error: null }

  const body = { p_poll_id: source.pollId, p_options: draft.added }
  return source.kind === 'poll'
    ? supabase.rpc('suggest_options', body)
    : supabase.rpc('open_poll_suggest_options', body)
}

/**
 * One option's two fields: a draft being typed, or a row already on the poll
 * opened by its pencil.
 *
 * Controlled, and holding nothing of its own, with no button of its own
 * either: what is typed here belongs to the list, and goes in on the press
 * that ends the card. See DraftHold.
 */
function OptionFields({
  value,
  problem,
  autoFocus,
  placeholder,
  ariaLabel,
  onChange,
}: {
  value: { name: string; description: string }
  /** What is wrong with it, or null. Marked on the field it is about. */
  problem: Problem | null
  /**
   * Whether the name field takes the cursor on arriving: a row opened by its
   * pencil or a field opened by *Add option*, which were each a press asking
   * for exactly that. The blank field the card starts with does not, since it
   * is here on arrival rather than opened.
   */
  autoFocus?: boolean
  placeholder?: string
  ariaLabel: string
  onChange: (value: { name: string; description: string }) => void
}) {
  return (
    <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
      <TextInput
        value={value.name}
        autoFocus={autoFocus}
        placeholder={placeholder}
        aria-label={ariaLabel}
        onChange={(e) => onChange({ ...value, name: e.currentTarget.value })}
        error={problem?.field === 'name' ? problem.message : null}
      />
      <DescriptionField
        value={value.description}
        onChange={(e) => onChange({ ...value, description: e.currentTarget.value })}
        placeholder="Description (optional)"
        error={problem?.field === 'description' ? problem.message : null}
      />
    </Stack>
  )
}

/**
 * The same list, on a poll that finds a time: a calendar rather than a text
 * box, and one request rather than one per window.
 *
 * Everything about *who may do what* is the same as the list above -- the
 * three sources are the same three, and only the creator may take something
 * off -- so what differs is the gesture and the endpoint it lands on. See
 * `PaintTimes` for the gesture and 0056_schedule_options.sql for why the
 * plural endpoint had to exist before a time poll could collect anything.
 */
function TimeList({
  source,
  options,
  schedule,
  isCreator,
  ownSave,
  draft,
  onChanged,
}: {
  source: OptionsSource
  options: PollOption[]
  schedule: PollSchedule
  isCreator: boolean
  /** Whether the calendar carries its own *Save times*; see CollectOptions. */
  ownSave: boolean
  /** Where the painting goes instead, when it does not. */
  draft: DraftHold
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The painting's difference from the list, as the calendar last reported
  // it. Held rather than read back out of it: a window is a run of cells, so
  // working out which windows a painting means is the calendar's job and is
  // done in one place.
  const [painted, setPainted] = useState<PaintedEdit | null>(null)

  const noteDraft = useCallback((edit: PaintedEdit | null) => {
    setPainted(edit)
  }, [])

  async function save(add: string[], removeIds: string[], quiet = false): Promise<boolean> {
    if (busy) return false
    setError(null)
    setBusy(true)

    // The creator's correction to a list that is already a ballot goes in as
    // one edit, because the two-option floor is applied to a live ballot a
    // row at a time: an afternoon swapped for another afternoon passes
    // through a list of one window, which is not a list anybody was offered.
    // See 0059_editing_options_in_one_go.sql.
    if (source.kind === 'creator') {
      const { error: rpcError } = await supabase.rpc('creator_edit_options', {
        p_poll_id: source.pollId,
        p_options: add.map((name) => ({ name })),
        p_remove: removeIds,
      })
      setBusy(false)

      if (rpcError) {
        setError(rpcError.message)
        return false
      }
      return landed(add, removeIds, quiet)
    }

    // Removals first, so a save that swaps one window for another cannot trip
    // over the 500-option ceiling on its way through the middle. A list still
    // being collected has no floor to fall through in between; that is
    // finalize_options's, when the list becomes a ballot.
    if (removeIds.length > 0) {
      const { error: deleteError } = await supabase.from('candidates').delete().in('id', removeIds)
      if (deleteError) {
        setBusy(false)
        setError(deleteError.message)
        return false
      }
    }

    const { error: rpcError } = add.length === 0 ? { error: null } : await sendTimes(source, add)
    setBusy(false)

    if (rpcError) {
      setError(rpcError.message)
      return false
    }

    return landed(add, removeIds, quiet)
  }

  /**
   * What every path does once the windows are in.
   *
   * `quiet` is a save made on the way past: the way out of the card --
   * *Confirm options*, or *Done* -- puts the painting in before it goes, and
   * that act says so itself and re-reads the poll once, at the end. See
   * DraftHold.
   */
  function landed(add: string[], removeIds: string[], quiet: boolean) {
    if (quiet) return true

    notifications.show({
      message:
        add.length > 0
          ? `Added ${add.length} ${add.length === 1 ? 'time' : 'times'}`
          : `Removed ${removeIds.length} ${removeIds.length === 1 ? 'time' : 'times'}`,
      color: 'green',
    })
    onChanged()
    return true
  }

  // The painting, left where the card's own button can apply it; see
  // DraftHold. After every render rather than once, so that what it puts in
  // is the painting as it now stands.
  useEffect(() => {
    draft.current = painted ? () => save(painted.add, painted.removeIds, true) : null

    return () => {
      draft.current = null
    }
  })

  return (
    <Stack gap="sm">
      <PaintTimes
        schedule={schedule}
        options={options}
        // Taking somebody else's suggestion off the list is the creator's job
        // everywhere else in this app, and is that here too.
        canRemove={isCreator}
        saving={busy}
        showSave={ownSave}
        onSave={save}
        onDraftChange={noteDraft}
      />
      {error && (
        <Text c="red" size="sm">
          {error}
        </Text>
      )}
    </Stack>
  )
}

/**
 * A painting's worth of windows, through whichever of the three doors this
 * reader came in by.
 *
 * One request whichever it is, which is the point: a gesture on that calendar
 * is a handful of windows, and inserting them one at a time could leave a day
 * with morning windows and no afternoon if the run stopped part-way.
 */
function sendTimes(source: OptionsSource, names: string[]) {
  const body = { p_options: names.map((name) => ({ name })) }
  if (source.kind === 'poll')
    return supabase.rpc('suggest_options', { p_poll_id: source.pollId, ...body })
  if (source.kind === 'creator') {
    return supabase.rpc('creator_add_options', { p_poll_id: source.pollId, ...body })
  }
  return supabase.rpc('open_poll_suggest_options', { p_poll_id: source.pollId, ...body })
}

/**
 * Who is done adding options, on an open poll that names its respondents.
 *
 * The invite side has no card of its own: its roster *is* the invite list, so
 * `Respondents` says it there, on the card it already draws, with the badge
 * answering "confirmed?" instead of "voted?" while the poll is still
 * collecting. Behind a share link there is no list to annotate — the names
 * exist only because people typed them — so there is a card.
 *
 * No embargo, unlike the voter roster it sits in place of. What that embargo
 * protects is the order ballots arrived in; a poll still collecting its
 * options has no ballots to attach an order to, and knowing who has finished
 * is the entire point of the thing.
 */
export function Confirmations({ names }: { names: string[] }) {
  return (
    <NameRoster
      title="Confirmed the options"
      names={names}
      empty="Nobody has confirmed the options yet."
    />
  )
}

/**
 * Which options were not in the list a moment ago.
 *
 * This list belongs to the poll rather than to whoever is looking at it: a
 * suggestion typed on somebody else's phone arrives here on the live tick,
 * with nothing to say it just did. Marking what is new is how a list that
 * grew under the reader says so, and it is the same mark whether the reader
 * added the row themselves or watched it turn up.
 *
 * **Nothing is new on the first read.** A card opening with six options has
 * not just been given six options, and animating them in one by one would
 * make the arrival of the card look like the arrival of its contents. So the
 * first list is taken as the starting position and only what follows counts.
 *
 * Answered a render late, because it is answered from an effect: the row is
 * drawn plain and the mark lands on the frame after, which is what makes the
 * animation run at all — a class an element is born with has nothing to
 * animate from.
 */
function useArrivals(options: PollOption[]): ReadonlySet<string> {
  const [arriving, setArriving] = useState<ReadonlySet<string>>(new Set())
  // Null until the first list has been seen, which is what tells "nothing has
  // arrived yet" apart from "the list is empty".
  const seen = useRef<Set<string> | null>(null)

  useEffect(() => {
    const ids = options.map((option) => option.id)
    const before = seen.current
    seen.current = new Set(ids)
    if (!before) return

    const added = ids.filter((id) => !before.has(id))
    if (added.length) setArriving(new Set(added))
  }, [options])

  return arriving
}
