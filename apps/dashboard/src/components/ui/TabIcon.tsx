/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import {
  BarChart3,
  CircleDollarSign,
  Code2,
  Container,
  Database,
  FileText,
  FlaskConical,
  Github,
  Layers,
  LayoutDashboard,
  Link2,
  List,
  Mail,
  Monitor,
  Search,
  Server,
  Settings,
  SquareTerminal,
  Users,
  Wallet,
} from './icon'
import type { ReactNode } from 'react'
import './TabIcon.css'

const GLYPHS = {
  overview: LayoutDashboard,
  terminal: SquareTerminal,
  chart: BarChart3,
  wallet: Wallet,
  settings: Settings,
  members: Users,
  document: FileText,
  credits: CircleDollarSign,
  endpoints: Link2,
  messages: Mail,
  images: Layers,
  registries: Server,
  boxes: Container,
  github: Github,
  code: Code2,
  browser: Monitor,
  data: Database,
  search: Search,
  testing: FlaskConical,
  list: List,
} as const

export type TabIconName = keyof typeof GLYPHS

// Fill only recognizable closed faces. Open glyphs retain their thin outline.
const FACES: Partial<Record<TabIconName, ReactNode>> = {
  overview: <rect x="3" y="3" width="7" height="9" rx="1" />,
  terminal: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="m7 11 2-2-2-2M11 13h4" className="tab-icon-cutout" />
    </>
  ),
  chart: (
    <>
      <rect x="7" y="14" width="2" height="3" />
      <rect x="12" y="5" width="2" height="12" />
      <rect x="17" y="9" width="2" height="8" />
    </>
  ),
  wallet: <path d="M18 12h3v4h-3a2 2 0 0 1 0-4Z" />,
  settings: <circle cx="12" cy="12" r="3" />,
  members: <circle cx="9" cy="7" r="4" />,
  document: <path d="M14 2v5a1 1 0 0 0 1 1h5Z" />,
  credits: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8M12 18V6" className="tab-icon-cutout" />
    </>
  ),
  messages: (
    <>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7" className="tab-icon-cutout" />
    </>
  ),
  images: <path d="m12 3 10 5-10 5L2 8Z" />,
  registries: (
    <>
      <rect x="2" y="2" width="20" height="8" rx="2" />
      <path d="M6 6h.01" className="tab-icon-cutout" />
    </>
  ),
  boxes: <path d="M3.7 8.3 11.35 12.7v8.1L4.3 16.77a.7.7 0 0 1-.6-.77Z" />,
  browser: <rect x="3" y="3" width="18" height="14" rx="2" />,
  data: <ellipse cx="12" cy="5" rx="9" ry="3" />,
  testing: <path d="M6.453 15h11.094l2.208 4.04A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96Z" />,
}

/** Decorative meaning; the parent trigger owns selection and accessible naming. */
export function TabIcon({ name }: { name: TabIconName }) {
  const Glyph = GLYPHS[name]
  return (
    <Glyph className="tab-icon size-4 shrink-0" aria-hidden="true" focusable="false">
      {FACES[name] && (
        <g className="tab-icon-face" fill="currentColor" stroke="none">
          {FACES[name]}
        </g>
      )}
    </Glyph>
  )
}
