import { Fragment, type CSSProperties } from 'react'
import { CheckIcon } from '@phosphor-icons/react'
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
 * The intro film for a phone: the three steps as a row of numbered dots
 * across the top with one title under them at a time, and the app at phone
 * width in a phone-shaped window below. Taps rather than a cursor, since that
 * is what the reader's own thumb does.
 */
const { w: CW, h: CH } = FILMS.portrait
const WIN = { x: 150, y: 590, w: 780, h: 1240 }
const VW = 390
const VH = (WIN.h * VW) / WIN.w
const BASE = { z: WIN.w / VW, fx: VW / 2, fy: VH / 2 }
const MAIN_H = VH - 60

interface RailStep {
  title: string
  appear: number
  done: number
}

function StepRail({ T, steps, opacity }: { T: number; steps: RailStep[]; opacity: number }) {
  const circle: CSSProperties = {
    position: 'absolute',
    inset: 0,
    borderRadius: 44,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 40,
    fontWeight: 700,
  }
  return (
    <div style={{ opacity }}>
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 150,
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
        }}
      >
        {steps.map((s, i) => {
          const a = p01(T, s.appear, s.appear + 0.35)
          const d = p01(T, s.done, s.done + 0.35)
          const prevD = i > 0 ? p01(T, steps[i - 1].done, steps[i - 1].done + 0.45) : 0
          return (
            <Fragment key={i}>
              {i > 0 && (
                <div
                  style={{
                    width: 120,
                    height: 6,
                    borderRadius: 3,
                    background: COL.track,
                    margin: '0 20px',
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{ width: prevD * 100 + '%', height: '100%', background: COL.green }}
                  />
                </div>
              )}
              <div style={{ position: 'relative', width: 88, height: 88, flex: 'none' }}>
                <div style={{ ...circle, background: COL.track, color: COL.dimmed }}>{i + 1}</div>
                <div
                  style={{
                    ...circle,
                    background: COL.blue,
                    color: '#fff',
                    opacity: a * (1 - d),
                    transform: `scale(${tween(T, s.appear, s.appear + 0.4, 0.75, 1, MOTION.pop)})`,
                  }}
                >
                  {i + 1}
                </div>
                <div
                  style={{
                    ...circle,
                    background: COL.green,
                    opacity: d,
                    transform: `scale(${tween(T, s.done, s.done + 0.4, 0.7, 1, MOTION.pop)})`,
                  }}
                >
                  <CheckIcon weight="bold" size={44} color="#fff" style={{ display: 'block' }} />
                </div>
              </div>
            </Fragment>
          )
        })}
      </div>
      {steps.map((s, i) => {
        const next = steps[i + 1]
        const a = p01(T, s.appear, s.appear + 0.45)
        const out = next ? p01(T, next.appear - 0.3, next.appear) : 0
        const o = a * (1 - out)
        if (o <= 0) return null
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: 70,
              right: 70,
              top: 300,
              textAlign: 'center',
              fontSize: 70,
              fontWeight: 700,
              lineHeight: 1.12,
              letterSpacing: -1,
              textWrap: 'balance',
              opacity: o,
              transform: `translateY(${(1 - a) * 24 - out * 12}px)`,
            }}
          >
            {s.title}
          </div>
        )
      })}
    </div>
  )
}

export function PortraitFilm({ T }: { T: number }) {
  const { Opening: O, Create: C, Rate: R, Decide: D, Close: X } = CUES
  const { create, poll, A, B } = useTargets()

  const tTitle = pt(A, 'title', 195, 110)
  const tOpts = pt(A, 'options', 195, 400)
  const tCreate = pt(A, 'create', 320, 680)
  const tSubmit = pt(B, 'submit', 320, 560)
  const tResults = pt(B, 'results', 195, 560)
  const tWinner = pt(B, 'winner', 195, 180)
  const rowsY = (pt(B, 'row-0', 0, 330).y + pt(B, 'row-3', 0, 480).y) / 2

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

  const cam = [
    { t: C, z: BASE.z, fx: BASE.fx, fy: BASE.fy },
    { t: C + 0.2, z: BASE.z, fx: BASE.fx, fy: BASE.fy },
    { t: C + 1.3, z: 2.25, fx: 0, fy: 60 + (tTitle.y + tOpts.y) / 2 },
    { t: C + 3.3, z: 2.27, fx: 0, fy: 60 + (tTitle.y + tOpts.y) / 2 },
    { t: C + 4.2, z: 2.2, fx: VW, fy: 60 + tCreate.y - maxA - 140 },
    { t: C + 4.4, z: 2.2, fx: VW, fy: 60 + tCreate.y - maxA - 140 },
    { t: R + 0.3, z: BASE.z, fx: BASE.fx, fy: BASE.fy },
    { t: R + 1.3, z: 2.15, fx: VW / 2, fy: 60 + (rowsY + tSubmit.y) / 2 },
    { t: R + 3.9, z: 2.17, fx: VW / 2, fy: 60 + (rowsY + tSubmit.y) / 2 },
    { t: R + 5.0, z: BASE.z, fx: BASE.fx, fy: BASE.fy },
    { t: D + 4.4, z: BASE.z, fx: BASE.fx, fy: BASE.fy },
    { t: D + 5.4, z: 2.3, fx: 0, fy: 60 + tWinner.y + 60 },
    { t: X, z: 2.32, fx: 0, fy: 60 + tWinner.y + 60 },
  ]
  const z = keyed(T, cam, 'z')
  const hw = WIN.w / (2 * z)
  const hh = WIN.h / (2 * z)
  const fx = clamp(keyed(T, cam, 'fx'), hw, Math.max(hw, VW - hw))
  const fy = clamp(keyed(T, cam, 'fy'), hh, Math.max(hh, VH - hh))

  // Finger taps
  const clicks = starClicks(R)
  const star = (r: number) => vB(pt(B, `star-${r}-${MY_SCORES[r]}`, 330, 330 + r * 50))
  const cA = vA(tCreate)
  let cur: { x: number; y: number; o: number; p: number } | null = null
  if (T >= C + 3.3 && T < C + 4.9) {
    const k = [
      { t: C + 3.4, x: 250, y: 470 },
      { t: C + 4.1, x: cA.x, y: cA.y },
    ]
    cur = {
      x: keyed(T, k, 'x'),
      y: keyed(T, k, 'y'),
      o: p01(T, C + 3.9, C + 4.1) * (1 - p01(T, C + 4.5, C + 4.75)),
      p: press(T, C + 4.22, 0.22),
    }
  } else if (T >= R + 0.4 && T < R + 4.4) {
    const s = [0, 1, 2, 3].map(star)
    const sb = vB(tSubmit)
    const k = [{ t: R + 0.5, x: 260, y: 500 }]
    clicks.forEach((c, i) => {
      k.push({ t: c - 0.05, x: s[i].x, y: s[i].y })
      k.push({ t: c + 0.12, x: s[i].x, y: s[i].y })
    })
    k.push({ t: R + 3.68, x: sb.x, y: sb.y })
    const taps = clicks.map((c) => c - 0.03).concat([R + 3.72])
    const near = Math.max(
      ...taps.map((c) => p01(T, c - 0.18, c - 0.05) * (1 - p01(T, c + 0.15, c + 0.3))),
    )
    cur = {
      x: keyed(T, k, 'x'),
      y: keyed(T, k, 'y'),
      o: near,
      p: Math.max(...taps.map((c) => press(T, c, 0.22))),
    }
  }

  const winO = p01(T, O + 2.35, O + 3.0) * (1 - p01(T, X, X + 0.5))
  const winY = tween(T, O + 2.35, O + 3.0, 50, 0)
  const winS = 1 - 0.04 * p01(T, X, X + 0.5)
  const aO = 1 - p01(T, R - 0.25, R - 0.05)
  const bO = p01(T, R - 0.1, R + 0.25)
  const bRise = tween(T, R - 0.1, R + 0.25, 6, 0)
  const railO = p01(T, C - 0.4, C + 0.1) * (1 - p01(T, X, X + 0.4))

  const LOGO_Y = 820
  const LOGO = 240
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
      x: lerp(CW / 2, destX, f),
      y: lerp(LOGO_Y, destY, f),
      size: lerp(LOGO * pop * drift, destSize, f),
      o: p01(T, O + 0.15, O + 0.45) * (T < C + 0.1 ? 1 : 0),
    }
  } else {
    const pop = tween(T, X + 0.45, X + 1.0, 0.6, 1, MOTION.pop)
    logo = {
      x: CW / 2,
      y: LOGO_Y,
      size: LOGO * pop * (1 + 0.02 * p01(T, X + 1, X + 2.5, Easing.linear)),
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
      <StepRail
        T={T}
        opacity={railO}
        steps={[
          { title: 'Create a poll', appear: C - 0.15, done: R - 0.1 },
          { title: 'Everyone rates the options', appear: R - 0.1, done: D - 0.1 },
          { title: 'Get a high‑quality decision', appear: D - 0.1, done: D + 4.8 },
        ]}
      />

      <div
        style={{
          position: 'absolute',
          left: WIN.x,
          top: WIN.y,
          width: WIN.w,
          height: WIN.h,
          background: '#fff',
          borderRadius: 40,
          overflow: 'hidden',
          border: '1px solid ' + COL.border,
          boxSizing: 'border-box',
          opacity: winO,
          transform: `translateY(${winY}px) scale(${winS})`,
          boxShadow: '0 50px 110px -24px rgba(33,37,41,0.2), 0 2px 8px rgba(33,37,41,0.05)',
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
          <AppHeader vw={VW} logoVisible={T >= C + 0.1} email={false} />
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
                left: cur.x - 16,
                top: cur.y - 16,
                width: 32,
                height: 32,
                borderRadius: 16,
                zIndex: 5,
                pointerEvents: 'none',
                background: `rgba(33,37,41,${0.16 + 0.14 * cur.p})`,
                boxShadow: '0 0 0 1.5px rgba(255,255,255,0.9), 0 2px 6px rgba(0,0,0,0.2)',
                opacity: cur.o,
                transform: `scale(${1 - 0.18 * cur.p})`,
              }}
            />
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
          top: LOGO_Y + LOGO / 2 + 50,
          textAlign: 'center',
          fontSize: 124,
          fontWeight: 700,
          letterSpacing: -2,
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
          left: 60,
          right: 60,
          top: LOGO_Y + LOGO / 2 + 210,
          textAlign: 'center',
          fontSize: 54,
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
