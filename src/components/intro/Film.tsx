import type { Ref } from 'react'
import {
  CLOSE,
  COL,
  Easing,
  FILMS,
  FONT,
  FOOTAGE,
  LANDED,
  footageSrc,
  headerLogo,
  lerp,
  LOGO_SRC,
  MOTION,
  p01,
  SECTIONS,
  TOTAL,
  tween,
  type FilmShape,
} from './motion'

/**
 * The intro film: the logo arriving, then the app itself — recorded on the
 * live site by scripts/intro/record.mjs — on a browser window or a phone,
 * one section at a time under a caption, and the logo coming back out of it
 * at the end.
 *
 * The logo's two flights land on and leave from the logo in the footage's own
 * header, so the film reads as the app opening and closing rather than as a
 * picture of it appearing. Nothing pans or zooms: a window that moves is a
 * window nobody believes.
 */
export function Film({
  T,
  shape,
  video,
}: {
  T: number
  shape: FilmShape
  video: Ref<HTMLVideoElement>
}) {
  const film = FILMS[shape]
  const { screen, bar } = film
  const home = headerLogo(shape)
  const closing = T >= CLOSE

  // The logo lands first and the screen fades in around it, so there is only
  // ever one logo: the flying one sits exactly over the footage's own until
  // the screen is whole. The close is the same backwards — the screen fades
  // from around the logo, and then it flies. Neither moves the screen, which
  // would pull the footage's logo out from under the flying one.
  const screenO = p01(T, LANDED, FOOTAGE) * (1 - p01(T, CLOSE, CLOSE + 0.5))

  let logo
  if (!closing) {
    const f = p01(T, 2.3, LANDED, MOTION.draw)
    const pop = tween(T, 0.15, 0.75, 0.6, 1, MOTION.pop)
    const drift = 1 + 0.03 * p01(T, 0, 2.3, Easing.linear)
    logo = {
      x: lerp(film.logo.x, home.x, f),
      y: lerp(film.logo.y, home.y, f),
      size: lerp(film.logo.size * pop * drift, home.size, f),
      // Handed to the footage's own once the screen is whole.
      o: p01(T, 0.15, 0.45) * (T < FOOTAGE ? 1 : 0),
      glow: 1 - p01(T, 2.3, LANDED),
    }
  } else {
    const f = p01(T, CLOSE + 0.5, CLOSE + 1.3, MOTION.draw)
    const to = film.closing.logo
    logo = {
      x: lerp(home.x, to.x, f),
      y: lerp(home.y, to.y, f),
      size:
        lerp(home.size, to.size, f) * (1 + 0.02 * p01(T, CLOSE + 1.3, CLOSE + 3.1, Easing.linear)),
      o: 1,
      glow: f,
    }
  }
  const wordO = closing
    ? p01(T, CLOSE + 1.1, CLOSE + 1.6)
    : p01(T, 0.4, 0.9) * (1 - p01(T, 2.15, 2.45))
  const wordY = closing ? tween(T, CLOSE + 1.1, CLOSE + 1.6, 16, 0) : tween(T, 0.4, 0.9, 16, 0)
  const tagO = closing ? 0 : p01(T, 0.75, 1.25) * (1 - p01(T, 2.1, 2.4))
  const tagY = tween(T, 0.75, 1.25, 12, 0)

  return (
    <div
      style={{
        position: 'relative',
        width: film.w,
        height: film.h,
        background: COL.bg,
        fontFamily: FONT,
        color: COL.text,
        overflow: 'hidden',
      }}
    >
      <Progress T={T} shape={shape} o={screenO} />

      {/* The screen: a browser window's bar and frame, or a phone's bezel. */}
      <div
        style={{
          position: 'absolute',
          left: screen.x,
          top: screen.y - bar,
          width: screen.w,
          height: screen.h + bar,
          opacity: screenO,
          visibility: seen(screenO),
          ...(shape === 'landscape'
            ? {
                borderRadius: 14,
                border: '1px solid ' + COL.border,
                background: '#fff',
                boxShadow: '0 40px 90px -20px rgba(33,37,41,0.20), 0 2px 6px rgba(33,37,41,0.05)',
              }
            : {
                borderRadius: 74,
                outline: '18px solid #1c1d21',
                background: '#fff',
                boxShadow: '0 50px 100px -20px rgba(33,37,41,0.35)',
              }),
          overflow: 'hidden',
        }}
      >
        {shape === 'landscape' && <WindowBar width={screen.w} height={bar} />}
        <video
          ref={video}
          src={footageSrc(shape, 'mp4')}
          poster={footageSrc(shape, 'jpg')}
          muted
          playsInline
          // A film opened on its last frame (less motion asked for) never
          // shows the footage, so does not fetch it.
          preload={T >= TOTAL ? 'none' : 'auto'}
          style={{ display: 'block', width: screen.w, height: screen.h }}
        />
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
            boxShadow: `0 ${logo.size * 0.12}px ${logo.size * 0.35}px rgba(121,80,242,${0.25 * logo.glow})`,
          }}
        />
      )}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: closing ? film.closing.word : film.word.top,
          textAlign: 'center',
          fontSize: film.word.size,
          fontWeight: 700,
          letterSpacing: -1.5,
          lineHeight: 1.1,
          opacity: wordO,
          visibility: seen(wordO),
          transform: `translateY(${wordY}px)`,
        }}
      >
        ChoiceLab
      </div>
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: film.tag.top,
          textAlign: 'center',
          fontSize: film.tag.size,
          color: COL.gray7,
          lineHeight: 1.3,
          opacity: tagO,
          visibility: seen(tagO),
          transform: `translateY(${tagY}px)`,
        }}
      >
        Group decisions, made simple.
      </div>
    </div>
  )
}

/**
 * Which section is playing, in words, over a bar for each that fills as it
 * plays: one thing at a time, and how far through the story it is.
 */
function Progress({ T, shape, o }: { T: number; shape: FilmShape; o: number }) {
  const { progress, caption, w } = FILMS[shape]
  const gap = 10
  const each = (progress.width - gap * (SECTIONS.length - 1)) / SECTIONS.length
  return (
    <div style={{ opacity: o, visibility: seen(o) }}>
      {SECTIONS.map((s, i) => (
        <div
          key={s.name}
          style={{
            position: 'absolute',
            left: (w - progress.width) / 2 + i * (each + gap),
            top: progress.top,
            width: each,
            height: 6,
            borderRadius: 3,
            background: COL.track,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${p01(T, s.start, s.end, Easing.linear) * 100}%`,
              height: '100%',
              background: COL.blue,
            }}
          />
        </div>
      ))}
      {SECTIONS.map((s, i) => {
        // Each caption fades in as its section starts and out as the next
        // one's does; the first arrives with the screen.
        const a = i === 0 ? 0 : p01(T, s.start - 0.15, s.start + 0.25)
        const b = i === SECTIONS.length - 1 ? 1 : 1 - p01(T, s.end - 0.15, s.end + 0.1)
        const shown = i === 0 ? b : a * b
        return (
          <div
            key={s.name}
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: caption.top,
              textAlign: 'center',
              fontSize: caption.size,
              fontWeight: 700,
              letterSpacing: -0.5,
              lineHeight: 1.15,
              opacity: shown,
              visibility: seen(shown),
              transform: `translateY(${(1 - a) * (i === 0 ? 0 : 14)}px)`,
            }}
          >
            {s.caption}
          </div>
        )
      })}
    </div>
  )
}

/** A browser window's bar: three lights and the app's address. */
function WindowBar({ width, height }: { width: number; height: number }) {
  return (
    <div
      style={{
        position: 'relative',
        width,
        height,
        background: COL.chrome,
        borderBottom: '1px solid ' + COL.border,
        boxSizing: 'border-box',
      }}
    >
      {['#ff5f57', '#febc2e', '#28c840'].map((c, i) => (
        <div
          key={c}
          style={{
            position: 'absolute',
            left: 20 + i * 22,
            top: height / 2 - 7,
            width: 14,
            height: 14,
            borderRadius: 7,
            background: c,
          }}
        />
      ))}
      <div
        style={{
          position: 'absolute',
          left: width / 2 - 220,
          top: 9,
          width: 440,
          height: height - 18,
          borderRadius: (height - 18) / 2,
          background: '#fff',
          border: '1px solid ' + COL.border,
          boxSizing: 'border-box',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 17,
          color: COL.gray7,
        }}
      >
        choicelab.app
      </div>
    </div>
  )
}

/**
 * Hidden outright when fully transparent, rather than merely so: a text at
 * no opacity is one an accessibility checker would still measure, and nobody
 * reads.
 */
const seen = (o: number) => (o > 0 ? 'visible' : 'hidden')
