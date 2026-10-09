import { CheckIcon, CursorIcon } from '@phosphor-icons/react'
import { AppHeader, CreatePage, Notification, PollPage } from './AppScreens'
import {
  clamp,
  COL,
  CUES,
  Easing,
  FILMS,
  FONT,
  keyed,
  lerp,
  LOGO_SRC,
  MOTION,
  MY_SCORES,
  p01,
  press,
  pt,
  starClicks,
  tween,
  useTargets,
} from './motion'

/**
 * The intro film for a wide screen: the three steps listed down the left, and
 * the app in a browser window on the right with a camera moving over it.
 */
const { w: CW, h: CH } = FILMS.landscape
const WIN = { x: 760, y: 110, w: 1040, h: 860 }
const VW = 770
const VH = (WIN.h * VW) / WIN.w
const BASE = { z: WIN.w / VW, fx: VW / 2, fy: VH / 2 }
const MAIN_H = VH - 60

function Step({
  T,
  n,
  title,
  appear,
  done,
  top,
}: {
  T: number
  n: number
  title: string
  appear: number
  done: number
  top: number
}) {
  const a = p01(T, appear, appear + 0.45)
  const d = p01(T, done, done + 0.35)
  return (
    <div
      style={{
        position: 'absolute',
        left: 120,
        top,
        width: 600,
        display: 'flex',
        gap: 28,
        alignItems: 'flex-start',
        opacity: a,
        transform: `translateX(${(1 - a) * -30}px)`,
      }}
    >
      <div style={{ position: 'relative', width: 76, height: 76, flex: 'none' }}>
        <div
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: 38,
            background: COL.blue,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#fff',
            fontSize: 36,
            fontWeight: 700,
            opacity: 1 - d,
          }}
        >
          {n}
        </div>
        <div
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: 38,
            background: COL.green,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            opacity: d,
            transform: `scale(${tween(T, done, done + 0.4, 0.7, 1, MOTION.pop)})`,
          }}
        >
          <CheckIcon weight="bold" size={38} color="#fff" style={{ display: 'block' }} />
        </div>
      </div>
      <div
        style={{
          fontSize: 46,
          fontWeight: 700,
          lineHeight: 1.15,
          letterSpacing: -0.5,
          color: d > 0.5 ? COL.dimmed : '#000',
          paddingTop: 7,
          textWrap: 'balance',
        }}
      >
        {title}
      </div>
    </div>
  )
}

export function LandscapeFilm({ T }: { T: number }) {
  const { Opening: O, Create: C, Rate: R, Decide: D, Close: X } = CUES
  const { create, poll, A, B } = useTargets()

  // Targets in content coordinates
  const tTitle = pt(A, 'title', 385, 110)
  const tOpts = pt(A, 'options', 385, 380)
  const tCreate = pt(A, 'create', 690, 640)
  const tSubmit = pt(B, 'submit', 690, 500)
  const tResults = pt(B, 'results', 385, 500)
  const tWinner = pt(B, 'winner', 385, 160)
  const rowsY = (pt(B, 'row-0', 0, 300).y + pt(B, 'row-3', 0, 440).y) / 2

  // Page scroll
  const maxA = Math.max(0, tCreate.y + tCreate.h / 2 + 16 - MAIN_H)
  const scrollA = tween(T, C + 3.3, C + 3.9, 0, maxA, MOTION.draw)
  const maxB = Math.max(0, tResults.y + tResults.h / 2 + 16 - MAIN_H)
  const scrollB = keyed(
    T,
    [
      { t: D + 1.8, s: 0 },
      { t: D + 2.5, s: maxB },
      { t: D + 3.9, s: maxB },
      { t: D + 4.6, s: 0 },
    ],
    's',
  )
  const vA = (p: { x: number; y: number }) => ({ x: p.x, y: 60 + p.y - scrollA })
  const vB = (p: { x: number; y: number }) => ({ x: p.x, y: 60 + p.y - scrollB })

  // Camera (viewport coordinates)
  const cam = [
    { t: C, z: BASE.z, fx: BASE.fx, fy: BASE.fy },
    { t: C + 0.2, z: BASE.z, fx: BASE.fx, fy: BASE.fy },
    { t: C + 1.3, z: 1.52, fx: 0, fy: 60 + (tTitle.y + tOpts.y) / 2 },
    { t: C + 3.3, z: 1.54, fx: 0, fy: 60 + (tTitle.y + tOpts.y) / 2 },
    { t: C + 4.2, z: 1.48, fx: VW, fy: 60 + tCreate.y - maxA - 140 },
    { t: C + 4.4, z: 1.48, fx: VW, fy: 60 + tCreate.y - maxA - 140 },
    { t: R + 0.3, z: BASE.z, fx: BASE.fx, fy: BASE.fy },
    { t: R + 1.3, z: 1.45, fx: VW / 2, fy: 60 + (rowsY + tSubmit.y) / 2 },
    { t: R + 3.9, z: 1.47, fx: VW / 2, fy: 60 + (rowsY + tSubmit.y) / 2 },
    { t: R + 5.0, z: BASE.z, fx: BASE.fx, fy: BASE.fy },
    { t: D + 4.4, z: BASE.z, fx: BASE.fx, fy: BASE.fy },
    { t: D + 5.4, z: 1.56, fx: 0, fy: 60 + tWinner.y + 60 },
    { t: X, z: 1.58, fx: 0, fy: 60 + tWinner.y + 60 },
  ]
  const z = keyed(T, cam, 'z')
  const hw = WIN.w / (2 * z)
  const hh = WIN.h / (2 * z)
  const fx = clamp(keyed(T, cam, 'fx'), hw, VW - hw)
  const fy = clamp(keyed(T, cam, 'fy'), hh, VH - hh)

  // Cursor
  const clicks = starClicks(R)
  const star = (r: number) => vB(pt(B, `star-${r}-${MY_SCORES[r]}`, 680, 300 + r * 50))
  const cA = vA(tCreate)
  let cur: { x: number; y: number; o: number; p: number } | null = null
  if (T >= C + 3.3 && T < C + 4.9) {
    const k = [
      { t: C + 3.4, x: 560, y: 420 },
      { t: C + 4.1, x: cA.x - 6, y: cA.y + 2 },
    ]
    cur = {
      x: keyed(T, k, 'x'),
      y: keyed(T, k, 'y'),
      o: p01(T, C + 3.3, C + 3.55) * (1 - p01(T, C + 4.6, C + 4.85)),
      p: press(T, C + 4.22, 0.2),
    }
  } else if (T >= R + 0.4 && T < R + 4.4) {
    const s = [0, 1, 2, 3].map(star)
    const sb = vB(tSubmit)
    const k = [{ t: R + 0.5, x: 520, y: 470 }]
    clicks.forEach((c, i) => {
      k.push({ t: c - 0.05, x: s[i].x, y: s[i].y })
      k.push({ t: c + 0.12, x: s[i].x, y: s[i].y })
    })
    k.push({ t: R + 3.68, x: sb.x - 10, y: sb.y + 2 })
    cur = {
      x: keyed(T, k, 'x'),
      y: keyed(T, k, 'y'),
      o: p01(T, R + 0.4, R + 0.65) * (1 - p01(T, R + 4.0, R + 4.3)),
      p: Math.max(...clicks.map((c) => press(T, c - 0.03, 0.2)), press(T, R + 3.72, 0.2)),
    }
  }

  // Window + pages
  const winO = p01(T, O + 2.35, O + 3.0) * (1 - p01(T, X, X + 0.5))
  const winY = tween(T, O + 2.35, O + 3.0, 40, 0)
  const winS = 1 - 0.04 * p01(T, X, X + 0.5)
  const aO = 1 - p01(T, R - 0.25, R - 0.05)
  const bO = p01(T, R - 0.1, R + 0.25)
  const bRise = tween(T, R - 0.1, R + 0.25, 6, 0)
  const railO = 1 - p01(T, X, X + 0.4)

  // Title cards: the logo flies into the app header and returns at the end
  const destSize = 32 * BASE.z
  const destX = WIN.x + WIN.w / 2 + (16 - BASE.fx) * BASE.z + destSize / 2
  const destY = WIN.y + WIN.h / 2 + (14 - BASE.fy) * BASE.z + destSize / 2
  const closing = T >= X
  const drift = 1 + 0.03 * p01(T, O, O + 2.3, Easing.linear)
  let logo
  if (!closing) {
    const f = p01(T, O + 2.3, O + 3.1, MOTION.draw)
    const pop = tween(T, O + 0.15, O + 0.75, 0.6, 1, MOTION.pop)
    logo = {
      x: lerp(960, destX, f),
      y: lerp(400, destY, f),
      size: lerp(168 * pop * drift, destSize, f),
      o: p01(T, O + 0.15, O + 0.45) * (T < C + 0.1 ? 1 : 0),
    }
  } else {
    const pop = tween(T, X + 0.45, X + 1.0, 0.6, 1, MOTION.pop)
    logo = {
      x: 960,
      y: 400,
      size: 168 * pop * (1 + 0.02 * p01(T, X + 1, X + 2.5, Easing.linear)),
      o: p01(T, X + 0.45, X + 0.7),
    }
  }
  const wordO = closing
    ? p01(T, X + 0.6, X + 1.1)
    : p01(T, O + 0.4, O + 0.9) * (1 - p01(T, O + 2.15, O + 2.45))
  const wordY = closing ? tween(T, X + 0.6, X + 1.1, 16, 0) : tween(T, O + 0.4, O + 0.9, 16, 0)
  const tagO = closing ? 0 : p01(T, O + 0.75, O + 1.25) * (1 - p01(T, O + 2.1, O + 2.4))
  const tagY = tween(T, O + 0.75, O + 1.25, 12, 0)

  return (
    <div
      style={{
        position: 'relative',
        width: CW,
        height: CH,
        background: COL.bg,
        fontFamily: FONT,
        color: COL.text,
        overflow: 'hidden',
      }}
    >
      <div style={{ opacity: railO }}>
        <Step T={T} n={1} title="Create a poll" appear={C - 0.15} done={R - 0.1} top={330} />
        <Step
          T={T}
          n={2}
          title="Everyone rates the options"
          appear={R - 0.1}
          done={D - 0.1}
          top={480}
        />
        <Step
          T={T}
          n={3}
          title={'Get a high‑quality decision'}
          appear={D - 0.1}
          done={D + 4.8}
          top={685}
        />
      </div>

      <div
        style={{
          position: 'absolute',
          left: WIN.x,
          top: WIN.y,
          width: WIN.w,
          height: WIN.h,
          background: '#fff',
          borderRadius: 16,
          overflow: 'hidden',
          border: '1px solid ' + COL.border,
          boxSizing: 'border-box',
          opacity: winO,
          transform: `translateY(${winY}px) scale(${winS})`,
          boxShadow: '0 40px 90px -20px rgba(33,37,41,0.18), 0 2px 6px rgba(33,37,41,0.05)',
        }}
      >
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: VW,
            height: VH,
            transformOrigin: '0 0',
            transform: `translate(${WIN.w / 2}px, ${WIN.h / 2}px) scale(${z}) translate(${-fx}px, ${-fy}px)`,
          }}
        >
          <AppHeader vw={VW} logoVisible={T >= C + 0.1} email />
          <div
            style={{
              position: 'absolute',
              left: 0,
              top: 60,
              width: VW,
              height: MAIN_H,
              overflow: 'hidden',
            }}
          >
            <CreatePage T={T} C={C} vw={VW} rootRef={create} scroll={scrollA} opacity={aO} />
            <PollPage
              T={T}
              R={R}
              D={D}
              vw={VW}
              rootRef={poll}
              scroll={scrollB}
              opacity={bO}
              rise={bRise}
            />
          </div>
          {cur && cur.o > 0 && (
            <div
              style={{
                position: 'absolute',
                left: cur.x - 5,
                top: cur.y - 4,
                opacity: cur.o,
                transform: `scale(${1 - 0.15 * cur.p})`,
                transformOrigin: '5px 4px',
                zIndex: 5,
              }}
            >
              <CursorIcon
                weight="fill"
                size={26}
                color="#000"
                style={{
                  display: 'block',
                  filter:
                    'drop-shadow(0 0 1.5px #fff) drop-shadow(0 0 1px #fff) drop-shadow(0 2px 3px rgba(0,0,0,.25))',
                }}
              />
            </div>
          )}
        </div>
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: VW,
            height: VH,
            transformOrigin: '0 0',
            transform: `scale(${BASE.z})`,
            pointerEvents: 'none',
          }}
        >
          <Notification T={T} from={R} to={R + 1.5} text="Poll created" />
          <Notification T={T} from={R + 3.85} to={R + 5.3} text="Vote submitted" />
        </div>
      </div>

      {logo.o > 0 && (
        <img
          src={LOGO_SRC}
          alt=""
          style={{
            position: 'absolute',
            left: logo.x - logo.size / 2,
            top: logo.y - logo.size / 2,
            width: logo.size,
            height: logo.size,
            borderRadius: logo.size / 4,
            opacity: logo.o,
            boxShadow: `0 ${logo.size * 0.12}px ${logo.size * 0.35}px rgba(121,80,242,${0.25 * (closing ? 1 : 1 - p01(T, O + 2.3, O + 3.0))})`,
          }}
        />
      )}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 520,
          textAlign: 'center',
          fontSize: 92,
          fontWeight: 700,
          letterSpacing: -1.5,
          lineHeight: 1.1,
          opacity: wordO,
          transform: `translateY(${wordY}px)`,
        }}
      >
        STAR Voting
      </div>
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 650,
          textAlign: 'center',
          fontSize: 42,
          color: COL.gray7,
          lineHeight: 1.3,
          opacity: tagO,
          transform: `translateY(${tagY}px)`,
        }}
      >
        Group decisions, made simple.
      </div>
    </div>
  )
}
