/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { useId } from 'react'

// Shared isometric axes keep every tile and connection on the Box's ground plane.
const point = (a: number, b: number) => `${210 + 36 * a - 36 * b},${177 + 20.8 * a + 20.8 * b}`
const GRID = [
  ...Array.from({ length: 7 }, (_, i) => `M${point(i - 3, -3)}L${point(i - 3, 8)}`),
  ...Array.from({ length: 12 }, (_, i) => `M${point(-3, i - 3)}L${point(3, i - 3)}`),
].join(' ')
const CONNECTIONS = [
  `M${point(-2, 7)}L${point(-2, 3)}L${point(0, 3)}L${point(0, 0)}`,
  `M${point(1, 6)}L${point(1, 2)}L${point(0, 2)}L${point(0, 0)}`,
  `M${point(-2, 4)}L${point(-2, 0)}L${point(0, 0)}`,
]

export default function WelcomeJourneyGround() {
  const fadeId = useId()
  return (
    <svg className="welcome-journey-ground" viewBox="-220 0 660 440" fill="none" aria-hidden="true">
      <defs>
        <radialGradient id={fadeId} cx="48%" cy="48%" r="58%">
          <stop offset="0" stopColor="currentColor" stopOpacity="0.16" />
          <stop offset="0.65" stopColor="currentColor" stopOpacity="0.09" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </radialGradient>
      </defs>
      <path d={GRID} stroke={`url(#${fadeId})`} strokeWidth="0.7" />
      <g className="welcome-ground-connections" stroke="currentColor" strokeWidth="0.8">
        {CONNECTIONS.map((path) => (
          <path key={path} d={path} />
        ))}
      </g>
      <g className="welcome-ground-signals text-brand" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        {CONNECTIONS.map((path) => (
          <path key={path} d={path} pathLength="1" />
        ))}
      </g>
      <g className="welcome-ground-nodes" stroke="currentColor" strokeWidth="0.8" strokeLinejoin="round">
        {[
          [-2, 7],
          [1, 6],
          [-2, 4],
        ].map(([a, b]) => (
          <g key={`${a}:${b}`} transform={`translate(${point(a, b)})`}>
            <path d="m-18 6 18 10.4L18 6" opacity="0.2" />
            <path d="m0-10.4 18 10.4L0 10.4-18 0Z" fill="var(--welcome-ground-tile)" opacity="0.5" />
            <path d="M-4 0h8M0-4v8" className="text-brand" opacity="0.65" />
          </g>
        ))}
      </g>
      <g stroke="currentColor" strokeWidth="0.65" opacity="0.18">
        <path d="M-162 260h24m-12-12v24M58 375h16m-8-8v16" />
        <circle cx="102" cy="239.4" r="2.5" />
      </g>
    </svg>
  )
}
