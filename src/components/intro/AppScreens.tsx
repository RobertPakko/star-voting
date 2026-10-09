import { Fragment, type CSSProperties, type ReactNode, type Ref } from 'react'
import {
  GearIcon,
  PlusIcon,
  SignOutIcon,
  StarIcon,
  SunIcon,
  XIcon,
  type Icon,
} from '@phosphor-icons/react'
import {
  arcPath,
  BADGE,
  COL,
  LOGO_SRC,
  MOTION,
  MY_SCORES,
  OPTIONS,
  p01,
  press,
  RUNOFF,
  starClicks,
  TALLY,
  tween,
  typed,
  VOTERS,
  type BadgeColor,
} from './motion'

/**
 * The app as the intro film draws it: the header, the create form, and the
 * poll page that is first a ballot and then a result. Shared by both shapes
 * of the film, which draw the same screens at two widths (`vw`).
 *
 * These are drawings of the app rather than the app — fixed light colours,
 * nothing interactive, every moving part a function of `T` — because the film
 * has to play identically for everybody and the real components read the
 * session, the database and the reader's colour scheme. They were drawn from
 * Layout, CreatePoll, PollHeading, BallotCard and Results, and nothing keeps
 * them in step with those; if one of those changes shape enough to matter, so
 * does the drawing.
 */

function Badge({
  color,
  children,
  style,
}: {
  color: BadgeColor
  children: ReactNode
  style?: CSSProperties
}) {
  const [bg, fg] = BADGE[color]
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        height: 20,
        padding: '0 10px',
        borderRadius: 1000,
        background: bg,
        color: fg,
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: 0.25,
        textTransform: 'uppercase',
        whiteSpace: 'nowrap',
        lineHeight: 1,
        ...style,
      }}
    >
      {children}
    </span>
  )
}

function OutlineIcon({ icon: Glyph }: { icon: Icon }) {
  return (
    <span
      style={{
        width: 34,
        height: 34,
        boxSizing: 'border-box',
        border: '1px solid ' + COL.gray6,
        borderRadius: 6,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: COL.gray6,
      }}
    >
      <Glyph size={18} style={{ display: 'block' }} />
    </span>
  )
}

function SubtleIcon({ icon: Glyph }: { icon: Icon }) {
  return (
    <span
      style={{
        width: 34,
        height: 36,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: COL.gray6,
        flex: 'none',
      }}
    >
      <Glyph size={18} style={{ display: 'block' }} />
    </span>
  )
}

function Caret({ on }: { on: boolean }) {
  return (
    <span
      style={{
        display: 'inline-block',
        width: 1,
        height: 17,
        background: '#000',
        marginLeft: 1,
        verticalAlign: 'middle',
        opacity: on ? 1 : 0,
      }}
    />
  )
}

function Input({
  value,
  placeholder,
  focused,
  caret,
  height = 36,
  tg,
}: {
  value?: string
  placeholder?: string
  focused?: boolean
  caret?: boolean
  height?: number
  tg?: string
}) {
  return (
    <div
      data-tg={tg}
      style={{
        height,
        boxSizing: 'border-box',
        border: '1px solid ' + (focused ? COL.blue : COL.inputBorder),
        borderRadius: 6,
        padding: height > 36 ? '7px 12px' : '0 12px',
        display: 'flex',
        alignItems: height > 36 ? 'flex-start' : 'center',
        fontSize: 14,
        lineHeight: '20px',
        background: '#fff',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
      }}
    >
      {value ? (
        <span>{value}</span>
      ) : (
        !focused && <span style={{ color: '#adb5bd' }}>{placeholder}</span>
      )}
      {focused && <Caret on={!!caret} />}
    </div>
  )
}

function Button({
  children,
  pressed = 0,
  tg,
  light,
}: {
  children: ReactNode
  pressed?: number
  tg?: string
  light?: boolean
}) {
  return (
    <span
      data-tg={tg}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        height: 36,
        padding: '0 18px',
        borderRadius: 6,
        background: light ? '#e7f5ff' : pressed > 0 ? COL.blueDark : COL.blue,
        color: light ? COL.blue : '#fff',
        fontSize: 14,
        fontWeight: 600,
        transform: `translateY(${pressed}px)`,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  )
}

const card = (p: number, extra?: CSSProperties): CSSProperties => ({
  border: '1px solid ' + COL.border,
  borderRadius: 8,
  background: '#fff',
  padding: p,
  boxSizing: 'border-box',
  ...extra,
})
const h4: CSSProperties = { fontSize: 18, fontWeight: 700, lineHeight: 1.45 }
const Divider = () => <div style={{ height: 1, background: COL.border }} />

/** Layout's header. The email is hidden below `sm`, as it is in the app. */
export function AppHeader({
  vw,
  logoVisible,
  email,
}: {
  vw: number
  logoVisible: boolean
  email: boolean
}) {
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: vw,
        height: 60,
        boxSizing: 'border-box',
        borderBottom: '1px solid ' + COL.border,
        background: '#fff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 16px',
        zIndex: 2,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <img
          src={LOGO_SRC}
          alt=""
          width={32}
          height={32}
          style={{ borderRadius: 8, display: 'block', opacity: logoVisible ? 1 : 0 }}
        />
        <div style={h4}>STAR Voting</div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {email && <span style={{ fontSize: 14, color: COL.dimmed }}>you@example.com</span>}
        <OutlineIcon icon={GearIcon} />
        <OutlineIcon icon={SunIcon} />
        <OutlineIcon icon={SignOutIcon} />
      </div>
    </div>
  )
}

interface PageProps {
  T: number
  vw: number
  rootRef: Ref<HTMLDivElement>
  scroll: number
  opacity: number
}

/** Step 1: the create form, typed into. */
export function CreatePage({ T, C, vw, rootRef, scroll, opacity }: PageProps & { C: number }) {
  const caret = Math.floor(T * 2.5) % 2 === 0
  const titleWin = [C + 0.35, C + 1.05]
  const optWins = [
    [C + 1.25, C + 1.75],
    [C + 1.85, C + 2.25],
    [C + 2.35, C + 2.8],
    [C + 2.9, C + 3.35],
  ]
  const typing = (w: number[]) => T >= w[0] && T <= w[1]
  const focusedOn = (w: number[], pre: number, post: number) => T >= w[0] - pre && T <= w[1] + post
  return (
    <div
      ref={rootRef}
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: vw,
        padding: 16,
        boxSizing: 'border-box',
        transform: `translateY(${-scroll}px)`,
        opacity,
      }}
    >
      <div
        style={{
          maxWidth: 720,
          margin: '0 auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        <div style={{ fontSize: 26, fontWeight: 700, lineHeight: 1.35, textAlign: 'center' }}>
          New poll
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={h4}>Title</div>
          <Input
            tg="title"
            value={typed(T, 'Movie night', titleWin[0], titleWin[1])}
            placeholder="A title for your poll"
            focused={focusedOn(titleWin, 0.15, 0.1)}
            caret={caret || typing(titleWin)}
          />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={h4}>Description</div>
          <Input height={60} placeholder="Optional additional details" />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={h4}>Decision</div>
          <div style={card(12)}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ background: '#f1f3f5', borderRadius: 6, padding: 4, display: 'flex' }}>
                <div
                  style={{
                    flex: 1,
                    background: '#fff',
                    borderRadius: 4,
                    boxShadow: '0 1px 3px rgba(0,0,0,.05), 0 1px 2px rgba(0,0,0,.1)',
                    textAlign: 'center',
                    fontSize: 14,
                    fontWeight: 500,
                    padding: '4px 10px',
                    lineHeight: 1.55,
                  }}
                >
                  Choose an option
                </div>
                <div
                  style={{
                    flex: 1,
                    textAlign: 'center',
                    fontSize: 14,
                    fontWeight: 500,
                    color: COL.gray7,
                    padding: '4px 10px',
                    lineHeight: 1.55,
                  }}
                >
                  Find a time
                </div>
              </div>
              <div style={{ fontSize: 12, color: COL.dimmed, lineHeight: 1.4 }}>
                Use + to add a description to an option.
              </div>
              <div data-tg="options" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {OPTIONS.map((name, i) => (
                  <div key={name} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                    <div style={{ flex: 1 }}>
                      <Input
                        value={typed(T, name, optWins[i][0], optWins[i][1])}
                        placeholder={`Option ${i + 1}`}
                        focused={focusedOn(optWins[i], 0.08, 0.06)}
                        caret={caret || typing(optWins[i])}
                      />
                    </div>
                    <SubtleIcon icon={PlusIcon} />
                    <SubtleIcon icon={XIcon} />
                  </div>
                ))}
              </div>
              <div>
                <Button light>Add option</Button>
              </div>
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button tg="create" pressed={press(T, C + 4.25, 0.22)}>
            Create poll
          </Button>
        </div>
      </div>
    </div>
  )
}

function Stars({
  value,
  row,
  T,
  clickAt,
}: {
  value: number
  row: number
  T: number
  clickAt: number
}) {
  const k = press(T, clickAt, 0.25)
  return (
    <div style={{ display: 'flex', flex: 'none' }}>
      {[1, 2, 3, 4, 5].map((s) => (
        <span
          key={s}
          data-tg={`star-${row}-${s}`}
          style={{ display: 'flex', padding: '6px 3px', lineHeight: 0 }}
        >
          <StarIcon
            weight="fill"
            size={20}
            color={s <= value ? COL.star : COL.starOff}
            style={{
              display: 'block',
              transform: `scale(${s === MY_SCORES[row] ? 1 + 0.22 * k : 1})`,
            }}
          />
        </span>
      ))}
    </div>
  )
}

function RunoffSide({
  name,
  preferred,
  color,
  side,
}: {
  name: string
  preferred: number
  color: string
  side: 'left' | 'right'
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: side === 'left' ? 'flex-start' : 'flex-end',
        flex: 1,
        minWidth: 0,
      }}
    >
      <div
        style={{
          display: 'flex',
          gap: 6,
          alignItems: 'center',
          flexDirection: side === 'left' ? 'row' : 'row-reverse',
        }}
      >
        <span style={{ width: 10, height: 10, borderRadius: 2, background: color, flex: 'none' }} />
        <span style={{ fontSize: 14, fontWeight: 700, lineHeight: 1.45 }}>{name}</span>
      </div>
      <span style={{ fontSize: 14, color: COL.dimmed, lineHeight: 1.45 }}>
        {preferred} voters preferred
      </span>
    </div>
  )
}

/** Steps 2 and 3: the poll page, as a ballot and then as a result. */
export function PollPage({
  T,
  R,
  D,
  vw,
  rootRef,
  scroll,
  opacity,
  rise,
}: PageProps & { R: number; D: number; rise: number }) {
  const clicks = starClicks(R)
  const ballotO = 1 - p01(T, R + 3.95, R + 4.2)
  const votersO = p01(T, R + 4.15, R + 4.4) * (1 - p01(T, D, D + 0.25))
  const resultsO = p01(T, D + 0.1, D + 0.4)
  const resultsY = tween(T, D + 0.1, D + 0.4, 6, 0)
  const doneO = p01(T, D + 0.1, D + 0.35)
  const maxPts = TALLY[0].pts
  const sweep = p01(T, D + 2.5, D + 3.4)
  const totalA = 180 * sweep
  const splitA = 180 - (totalA * RUNOFF.pa) / (RUNOFF.pa + RUNOFF.pb)
  const winO = p01(T, D + 4.5, D + 4.85)
  const winY = tween(T, D + 4.5, D + 4.85, 6, 0)
  return (
    <div
      ref={rootRef}
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: vw,
        padding: 16,
        boxSizing: 'border-box',
        transform: `translateY(${rise - scroll}px)`,
        opacity,
      }}
    >
      <div
        style={{
          maxWidth: 720,
          margin: '0 auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
              <div style={{ flex: '1 1 60%', fontSize: 26, fontWeight: 700, lineHeight: 1.35 }}>
                Movie night
              </div>
              <div style={{ display: 'grid', justifyItems: 'end', paddingTop: 4 }}>
                <Badge color="orange" style={{ gridArea: '1/1', opacity: 1 - doneO }}>
                  In progress
                </Badge>
                <Badge
                  color="green"
                  style={{
                    gridArea: '1/1',
                    opacity: doneO,
                    transform: `scale(${1 + 0.09 * press(T, D + 0.1, 0.3)})`,
                  }}
                >
                  Results ready
                </Badge>
              </div>
            </div>
            <div style={{ fontSize: 16, color: COL.dimmed, lineHeight: 1.55 }}>
              What are we watching on Friday?
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <Badge color="grape">Open link</Badge>
            <Badge color="cyan">Voters shown</Badge>
            <Badge color="lime">Ballots published</Badge>
          </div>
        </div>

        <div style={{ position: 'relative' }}>
          <div style={card(16, { opacity: ballotO })}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 500, lineHeight: 1.55 }}>
                  Your name <span style={{ color: COL.red }}>*</span>
                </div>
                <div style={{ marginTop: 2 }}>
                  <Input value="Alex" />
                </div>
              </div>
              <div style={{ fontSize: 14, lineHeight: 1.45 }}>
                Rate each option from 0 to 5 stars. 5 is the highest preference while 0 is the
                lowest.
              </div>
              <Divider />
              {OPTIONS.map((name, i) => (
                <Fragment key={name}>
                  <div
                    data-tg={`row-${i}`}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 12,
                    }}
                  >
                    <div style={{ fontSize: 16, fontWeight: 500, lineHeight: 1.55 }}>{name}</div>
                    <Stars
                      row={i}
                      T={T}
                      clickAt={clicks[i]}
                      value={T >= clicks[i] ? MY_SCORES[i] : 0}
                    />
                  </div>
                  <Divider />
                </Fragment>
              ))}
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <Button tg="submit" pressed={press(T, R + 3.75, 0.22)}>
                  Submit vote
                </Button>
              </div>
            </div>
          </div>

          <div
            data-tg="voters"
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
              opacity: votersO,
            }}
          >
            <div style={h4}>Voters</div>
            <div style={card(16)}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                {VOTERS.map((n, i) => {
                  const a = R + 4.35 + i * 0.1
                  return (
                    <Badge
                      key={n}
                      color="green"
                      style={{
                        opacity: p01(T, a, a + 0.15),
                        transform: `scale(${tween(T, a, a + 0.3, 0.6, 1, MOTION.pop)})`,
                      }}
                    >
                      {n}
                    </Badge>
                  )
                })}
              </div>
            </div>
          </div>

          <div
            data-tg="results"
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 16,
              opacity: resultsO,
              transform: `translateY(${resultsY}px)`,
            }}
          >
            <div
              data-tg="winner"
              style={card(16, {
                background: '#d3f9d8',
                opacity: winO,
                transform: `translateY(${winY}px)`,
              })}
            >
              <div style={{ fontSize: 18, fontWeight: 700, lineHeight: 1.55 }}>
                Winner: Knives Out
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <div style={h4}>Scoring</div>
              <div data-tg="scoring" style={card(12)}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {TALLY.map((o, i) => {
                    const w =
                      p01(T, D + 0.45 + i * 0.12, D + 1.35 + i * 0.12) * (o.pts / maxPts) * 100
                    return (
                      <div key={o.name}>
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            gap: 10,
                            marginBottom: 2,
                          }}
                        >
                          <span
                            style={{
                              fontSize: 14,
                              lineHeight: 1.45,
                              fontWeight: o.fin ? 700 : 400,
                            }}
                          >
                            {o.name}
                          </span>
                          <span
                            style={{
                              fontSize: 14,
                              lineHeight: 1.45,
                              color: COL.dimmed,
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {o.pts} pts (avg {Number((o.pts / 9).toFixed(2))})
                          </span>
                        </div>
                        <div
                          style={{
                            height: 8,
                            borderRadius: 4,
                            background: COL.track,
                            overflow: 'hidden',
                          }}
                        >
                          <div
                            style={{
                              height: '100%',
                              width: w + '%',
                              background: o.fin ? COL.blue : COL.gray6,
                              borderRadius: 4,
                            }}
                          />
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <div style={h4}>Runoff</div>
              <div data-tg="runoff" style={card(12)}>
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 10,
                    alignItems: 'center',
                  }}
                >
                  <svg
                    width="240"
                    height="121"
                    viewBox="0 0 240 121"
                    style={{ marginTop: 8, display: 'block' }}
                  >
                    {totalA > 0.5 && (
                      <path
                        d={arcPath(120, 120, 120, 180, splitA)}
                        fill={COL.blue}
                        stroke="#fff"
                        strokeWidth="1"
                      />
                    )}
                    {180 - totalA < splitA - 0.5 && (
                      <path
                        d={arcPath(120, 120, 120, splitA, 180 - totalA)}
                        fill={COL.violet}
                        stroke="#fff"
                        strokeWidth="1"
                      />
                    )}
                  </svg>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'flex-start',
                      gap: 16,
                      width: '100%',
                      maxWidth: 360,
                    }}
                  >
                    <RunoffSide
                      name={RUNOFF.a}
                      preferred={RUNOFF.pa}
                      color={COL.blue}
                      side="left"
                    />
                    <RunoffSide
                      name={RUNOFF.b}
                      preferred={RUNOFF.pb}
                      color={COL.violet}
                      side="right"
                    />
                  </div>
                  <div style={{ fontSize: 14, color: COL.dimmed, lineHeight: 1.45 }}>
                    0 voters scored both finalists equally.
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/** A Mantine notification in the window's corner, between `from` and `to`. */
export function Notification({
  T,
  from,
  to,
  text,
}: {
  T: number
  from: number
  to: number
  text: string
}) {
  const o = p01(T, from, from + 0.25) * (1 - p01(T, to - 0.25, to))
  if (o <= 0) return null
  return (
    <div
      style={{
        position: 'absolute',
        right: 16,
        bottom: 16,
        width: 300,
        background: '#fff',
        borderRadius: 6,
        opacity: o,
        transform: `translateY(${(1 - p01(T, from, from + 0.3)) * 16}px)`,
        boxShadow:
          '0 1px 3px rgba(0,0,0,.05), 0 28px 23px -7px rgba(0,0,0,.05), 0 12px 12px -7px rgba(0,0,0,.04)',
        border: '1px solid ' + COL.border,
        padding: '10px 12px 10px 22px',
        boxSizing: 'border-box',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}
    >
      <span
        style={{
          position: 'absolute',
          left: 4,
          top: 4,
          bottom: 4,
          width: 6,
          borderRadius: 4,
          background: COL.green,
        }}
      />
      <span style={{ fontSize: 14, lineHeight: 1.45 }}>{text}</span>
      <XIcon size={16} color={COL.gray6} style={{ display: 'block' }} />
    </div>
  )
}
