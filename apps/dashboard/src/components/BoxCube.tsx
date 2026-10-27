/*
 * Modified by BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { cn } from '@/lib/utils'

/**
 * The Box, drawn. One isometric wireframe cube, in the states a box can be in,
 * so the same object is recognisable from the marketing site's hero down to a
 * 16px glyph in a table row. Single stroke, `currentColor`; brand is spent on
 * the one thing that distinguishes the state.
 *
 * Vertices (64×64): top face A(32,10) B(54,22) C(32,34) D(10,22); the two
 * visible side faces hang from D–C–B down to D'(10,44) C'(32,56) B'(54,44).
 */
export type CubeState = 'empty' | 'building' | 'disposable' | 'persistent' | 'reachable' | 'error' | 'stopped'

const TOP = 'M32 10L54 22L32 34L10 22Z'
const LEFT = 'M10 22L32 34L32 56L10 44Z'
const RIGHT = 'M32 34L54 22L54 44L32 56Z'

export function BoxCube({
  state,
  className,
  size = 64,
  title,
}: {
  state: CubeState
  className?: string
  size?: number
  title?: string
}) {
  // Below ~28px the accents turn to noise; the outline and its treatment
  // (dashed / faded / broken) carry the state on their own.
  const detailed = size >= 28
  const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinejoin: 'round' } as const
  const brand = 'hsl(var(--brand))'

  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={cn('shrink-0', state === 'stopped' && 'opacity-50', className)}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {state === 'building' ? (
        // A box assembling itself: each face's outline draws in, then the top
        // lights once the three have met. The console's own loading state is
        // the thing the console is about, rather than a generic spinner.
        <>
          {[TOP, LEFT, RIGHT].map((face, i) => (
            <path
              key={i}
              d={face}
              {...stroke}
              strokeDasharray={140}
              style={{ animation: `box-draw 2.4s ease-in-out ${(i * 0.22).toFixed(2)}s infinite` }}
              className="motion-reduce:animate-none"
            />
          ))}
          <path
            d={TOP}
            fill={brand}
            fillOpacity={0}
            style={{ animation: 'box-lit 2.4s ease-in-out 0.66s infinite' }}
            className="motion-reduce:hidden"
          />
        </>
      ) : state === 'empty' ? (
        <>
          <path d={TOP} {...stroke} strokeDasharray="3 3" />
          <path d={LEFT} {...stroke} strokeDasharray="3 3" />
          <path d={RIGHT} {...stroke} strokeDasharray="3 3" />
        </>
      ) : state === 'error' ? (
        <>
          <path d={TOP} {...stroke} />
          {/* the front edge is broken: the box exists, its integrity does not */}
          <path d="M10 22L32 34L32 42M32 50L32 56L10 44Z" {...stroke} />
          <path d={RIGHT} {...stroke} />
          {detailed && <path d="M29 42L35 50" stroke="hsl(var(--destructive))" strokeWidth={2} />}
        </>
      ) : (
        <>
          {state === 'persistent' && (
            // a foundation under the box: what it stands on survives it
            <path d="M10 50L32 62L54 50" {...stroke} opacity={0.45} />
          )}
          <path d={TOP} {...stroke} />
          <path d={LEFT} {...stroke} />
          {state === 'reachable' ? (
            // the right face is a screen: lit, and something is leaving through it
            <path d={RIGHT} fill="hsl(var(--brand) / 0.16)" stroke="currentColor" strokeWidth={1.5} />
          ) : (
            <path d={RIGHT} {...stroke} />
          )}
          {detailed && state === 'reachable' && (
            <path d="M43 39L60 22M50 22H60V32" fill="none" stroke={brand} strokeWidth={2} strokeLinecap="round" />
          )}
          {detailed && state === 'disposable' && (
            // in at the top, out at the bottom: run · exit · gone
            <>
              <path d="M32 0V8M28 5L32 9L36 5" fill="none" stroke={brand} strokeWidth={2} strokeLinecap="round" />
              <path d="M40 60H48M45 57L48 60L45 63" fill="none" stroke="currentColor" strokeWidth={1.5} opacity={0.6} />
            </>
          )}
          {detailed && state === 'persistent' && <circle cx="32" cy="45" r="2.2" fill={brand} />}
        </>
      )}
    </svg>
  )
}
