/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { useLayoutEffect, useRef, useState } from 'react'
import type { FirstRunUseCase } from '@/lib/first-run'
import WelcomeBoxIllustration, { type WelcomeBoxPhase } from './WelcomeBoxIllustration'
import WelcomeJourneyGround from './WelcomeJourneyGround'
import './WelcomeJourneyArtwork.css'

type Placement = { x: number; y: number; width: number }

/** Keeps one Box alive while its placement and appearance follow the welcome steps. */
export default function WelcomeJourneyArtwork({
  step,
  selection,
  mainElement,
  creditsAnchor,
}: {
  step: WelcomeBoxPhase
  selection: FirstRunUseCase | null
  mainElement: HTMLElement | null
  creditsAnchor: HTMLDivElement | null
}) {
  const layerRef = useRef<HTMLDivElement>(null)
  const [placement, setPlacement] = useState<Placement | null>(null)

  useLayoutEffect(() => {
    const container = layerRef.current?.parentElement
    const main = mainElement
    if (!container || !main || (step === 'credits' && !creditsAnchor)) return

    const place = () => {
      const bounds = container.getBoundingClientRect()
      let next: Placement
      if (step === 'credits' && creditsAnchor) {
        const target = creditsAnchor.getBoundingClientRect()
        next = { x: target.left - bounds.left, y: target.top - bounds.top, width: target.width }
      } else {
        const contentLeft = main.getBoundingClientRect().left + (parseFloat(getComputedStyle(main).paddingLeft) || 0)
        const form = main.querySelector('form')?.getBoundingClientRect()
        const space = Math.max(0, (form?.left ?? contentLeft) - contentLeft - 40)
        const width = Math.min(380, space)
        next = {
          x: contentLeft - bounds.left + (space - width) / 2 - 28,
          y: (form?.top ?? bounds.top) - bounds.top + 56,
          width,
        }
      }
      setPlacement((previous) =>
        previous?.x === next.x && previous.y === next.y && previous.width === next.width ? previous : next,
      )
    }
    place()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(place)
    observer.observe(container)
    observer.observe(main)
    if (creditsAnchor) observer.observe(creditsAnchor)
    return () => observer.disconnect()
  }, [step, mainElement, creditsAnchor])

  return (
    <div ref={layerRef} className="welcome-journey-backdrop" data-step={step} aria-hidden="true">
      <div className="welcome-journey-grain" />
      <div
        className="welcome-journey-art"
        style={{
          visibility: placement ? 'visible' : 'hidden',
          transform: placement
            ? `translate3d(${placement.x}px, ${placement.y}px, 0) scale(${placement.width / 420})`
            : undefined,
        }}
      >
        <WelcomeJourneyGround />
        <WelcomeBoxIllustration phase={step} selection={selection} />
      </div>
    </div>
  )
}
