/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { CheckpointGlyph } from './CheckpointGlyph'
import {
  BookOpen,
  Building2,
  Container,
  CreditCardIcon,
  Github,
  Globe,
  HardDrive,
  Layers,
  Play,
  Server,
  Settings,
} from './ui/icon'
import { cn } from '@/lib/utils'
import './NavigationIcon.css'

const GLYPHS = {
  box: Container,
  images: Layers,
  volume: HardDrive,
  domain: Globe,
  ci: Play,
  registry: Server,
  github: Github,
  management: Settings,
  billing: CreditCardIcon,
  organization: Building2,
  quickstart: BookOpen,
}

export type NavigationIconName = keyof typeof GLYPHS | 'checkpoint'

/** Partial faces are drawn last so filled regions cannot hide their reversed details. */
function SelectedFace({ name }: { name: NavigationIconName }) {
  switch (name) {
    case 'box':
      return <path d="M3.7 8.3 11.35 12.7v8.1L4.3 16.77a.7.7 0 0 1-.6-.77Z" />
    case 'volume':
      return (
        <>
          <path d="M2 12h20v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2Z" />
          <path d="M6 16h.01M10 16h.01" className="navigation-icon-cutout" strokeWidth="1.8" />
        </>
      )
    case 'organization':
      return (
        <>
          <path d="M6 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16Z" />
          <path d="M10 8h4M10 12h4M10 21v-3a2 2 0 0 1 4 0v3" className="navigation-icon-cutout" />
        </>
      )
    case 'quickstart':
      return <path d="M3 3h5a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
    default:
      return null
  }
}

/** Sidebar-only selected variants; resource glyphs and their state colors are independent. */
export function NavigationIcon({
  name,
  selected,
  className,
}: {
  name: NavigationIconName
  selected: boolean
  className?: string
}) {
  const Glyph = name === 'checkpoint' ? null : GLYPHS[name]
  return (
    <span
      className={cn('navigation-icon inline-flex size-[18px] shrink-0', className)}
      data-icon={name}
      data-selected={selected}
      aria-hidden="true"
    >
      {Glyph ? (
        <Glyph className="size-full" focusable="false">
          <g className="navigation-icon-face" fill="currentColor" stroke="none">
            <SelectedFace name={name} />
          </g>
        </Glyph>
      ) : (
        <CheckpointGlyph className="size-full" />
      )}
    </span>
  )
}
