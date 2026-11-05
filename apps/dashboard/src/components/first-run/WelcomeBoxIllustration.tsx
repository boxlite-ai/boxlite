/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { useEffect, useRef } from 'react'
import './WelcomeBoxIllustration.css'

export type WelcomeBoxPhase = 'organization' | 'intent' | 'credits'
const OUTER_FRAME = 'm240 22-104 60v112l104 60 104-60V82Z'
const INNER_EDGES = 'm136 82 104 60 104-60M240 142v112'
const LOOP_NAMES = new Set(['welcome-box-float', 'welcome-box-breathe', 'welcome-box-shadow'])

/** BoxLite's nested-cube mark, with motion that respects the system preference. */
export default function WelcomeBoxIllustration({
  phase = 'credits',
  selection = null,
}: {
  phase?: WelcomeBoxPhase
  selection?: string | null
}) {
  const svgRef = useRef<SVGSVGElement>(null)
  useEffect(() => {
    const svg = svgRef.current
    if (!svg?.getAnimations) return
    let frame = 0
    const updateRate = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const rate = phase === 'organization' ? 0.5 : phase === 'intent' ? 0.75 : 1
        for (const animation of svg.getAnimations({ subtree: true })) {
          if ('animationName' in animation && LOOP_NAMES.has(String(animation.animationName)))
            animation.updatePlaybackRate(rate)
        }
      })
    }
    const media = [
      window.matchMedia('(min-width: 1024px)'),
      window.matchMedia('(min-width: 1180px)'),
      window.matchMedia('(prefers-reduced-motion: reduce)'),
    ]
    updateRate()
    media.forEach((query) => query.addEventListener('change', updateRate))
    return () => {
      cancelAnimationFrame(frame)
      media.forEach((query) => query.removeEventListener('change', updateRate))
    }
  }, [phase, selection])

  return (
    <svg
      ref={svgRef}
      data-phase={phase}
      data-selected={Boolean(selection)}
      viewBox="0 -32 480 310"
      fill="none"
      aria-hidden="true"
      className="welcome-box-artwork h-auto w-full max-w-[460px] text-foreground"
    >
      <g className="welcome-box-floor" stroke="currentColor" strokeWidth="0.6" opacity="0.09">
        <path d="m46 160 194 112 194-112M78 142l194 112M110 123l194 112M142 105l194 112M174 86l194 112M206 68l194 112M240 48l194 112" />
        <path d="m46 160 194-112M78 179l194-112M110 197l194-112M142 216l194-112M174 234l194-112M206 253l194-112" />
      </g>
      <path className="welcome-box-shadow" d="m240 158-82 47 82 47 82-47Z" fill="currentColor" />
      <g className="welcome-box-float">
        <g className="welcome-box-reveal">
          <g className="welcome-box-surfaces">
            <path d="m136 82 104 60 104-60-104-60Z" fill="currentColor" fillOpacity="0.015" />
            <path d="M136 82v112l104 60V142Z" fill="currentColor" fillOpacity="0.025" />
            <path d="M344 82v112l-104 60V142Z" fill="currentColor" fillOpacity="0.01" />
            <g stroke="currentColor" strokeWidth="0.9" opacity="0.18" strokeDasharray="3 5">
              <path d="M240 22v112m0 0-104 60m104-60 104 60" />
            </g>
          </g>
          <g className="welcome-box-core-visibility">
            <g key={selection} className="welcome-box-selection">
              <g className="welcome-box-core text-brand" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round">
                <path d="m240 78-45 26 45 26 45-26Z" fill="currentColor" fillOpacity="0.12" />
                <path d="M195 104v50l45 26v-50Z" fill="currentColor" fillOpacity="0.35" />
                <path d="M285 104v50l-45 26v-50Z" fill="currentColor" fillOpacity="0.7" />
              </g>
            </g>
          </g>
        </g>
        <g className="welcome-box-outline" stroke="currentColor" strokeWidth="1" opacity="0.45" strokeLinejoin="round">
          <path pathLength="1" d={OUTER_FRAME} />
          <path pathLength="1" d={INNER_EDGES} />
        </g>
        <g
          className="welcome-box-dots"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeDasharray="0.001 0.02"
        >
          <path pathLength="1" d={OUTER_FRAME} />
          <path pathLength="1" d={INNER_EDGES} />
        </g>
      </g>
      <g stroke="currentColor" strokeWidth="0.8" opacity="0.22">
        <path d="M90 82H60m15-15v30M392 194h30m-15-15v30" />
        <path d="M136 211v14m208-14v14" />
      </g>
    </svg>
  )
}
