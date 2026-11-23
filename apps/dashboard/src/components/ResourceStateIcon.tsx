/* Copyright BoxLite AI, 2026 · SPDX-License-Identifier: AGPL-3.0 */
import type { CSSProperties } from 'react'
import type { Box } from '@boxlite-ai/api-client'
import {
  getBoxIconState,
  getVolumeIconState,
  RESOURCE_ICON_COLORS,
  type ResourceIconState,
} from '@/lib/resource-icon-state'
import { cn } from '@/lib/utils'

type IconProps = { className?: string }
const BOX_OUTLINE = 'm12 2 9 5v10l-9 5-9-5V7Z'

/** Decorative state accents keep the object's outline and adjacent status text stable. */
function ResourceStateIcon({
  kind,
  status,
  className,
}: IconProps & { kind: 'box' | 'volume' | 'domain'; status: ResourceIconState }) {
  const accented = status.tone !== 'neutral'
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={cn('resource-state-icon size-5 shrink-0 text-muted-foreground', className)}
      style={{ '--resource-state-color': RESOURCE_ICON_COLORS[status.tone] } as CSSProperties}
    >
      {kind === 'box' && (
        <>
          <path d={BOX_OUTLINE} />
          <path d="m3 7 9 5 9-5M12 12v10" />
          {accented && !status.active && (
            <>
              <path className="resource-state-face" d="m12 12 9-5v10l-9 5Z" />
              <path className="resource-state-accent" d="M12 12v10" />
            </>
          )}
          {status.active && <path className="resource-state-trace" pathLength={52} d={BOX_OUTLINE} />}
        </>
      )}
      {kind === 'volume' && (
        <>
          <path d="M4 13 7 4h10l3 9M4 13h16a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1Z" />
          <path d="M6 16.5h.01M9 16.5h.01" />
          {accented && (
            <circle
              className={cn('resource-state-light', status.active && 'resource-state-breathe')}
              cx={17}
              cy={16.5}
              r={1.15}
            />
          )}
          {status.tone === 'error' && <path className="resource-state-accent" d="M14 20h6" />}
        </>
      )}
      {kind === 'domain' && (
        <>
          <circle cx={12} cy={12} r={9} />
          <path d="M3 12h18M12 3a16 16 0 0 1 0 18 16 16 0 0 1 0-18Z" />
          {accented && (
            <>
              <path className="resource-state-accent" d="M12 3a16 16 0 0 1 3 9" />
              <circle className="resource-state-light" cx={15} cy={12} r={1.65} />
            </>
          )}
        </>
      )}
    </svg>
  )
}

export function BoxResourceIcon({ box, ...props }: IconProps & { box: Pick<Box, 'state'> }) {
  return <ResourceStateIcon kind="box" status={getBoxIconState(box)} {...props} />
}

export function VolumeResourceIcon({ state, ...props }: IconProps & { state: string }) {
  return <ResourceStateIcon kind="volume" status={getVolumeIconState(state)} {...props} />
}

/** A binding exists; this does not assert endpoint health, DNS readiness or traffic. */
export function DomainResourceIcon({ bound, ...props }: IconProps & { bound: boolean }) {
  return <ResourceStateIcon kind="domain" status={{ tone: bound ? 'bound' : 'neutral', active: false }} {...props} />
}
