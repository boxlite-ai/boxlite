/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import goIcon from '@/assets/go.svg'
import pythonIcon from '@/assets/python.svg'
import { RustIcon } from '@/assets/RustIcon'
import typescriptIcon from '@/assets/typescript.svg'
import { FileText, Server, Terminal } from '@/components/ui/icon'
import type { QuickstartIconName } from '@/lib/quickstart/types'
import type { ComponentType } from 'react'

// Multi-color brand marks ship as assets; single-color marks render inline so they
// inherit `currentColor` and stay visible in both themes.
const ICON_ASSETS: Partial<Record<QuickstartIconName, string>> = {
  go: goIcon,
  python: pythonIcon,
  typescript: typescriptIcon,
}
const ICON_COMPONENTS: Partial<
  Record<QuickstartIconName, ComponentType<{ className?: string; 'aria-hidden'?: boolean }>>
> = {
  file: FileText,
  rust: RustIcon,
  server: Server,
  terminal: Terminal,
}

/** Keep SDK brand marks identical wherever code languages are chosen. */
export function QuickstartInterfaceIcon({
  icon,
  className = 'size-4',
}: {
  icon: QuickstartIconName
  className?: string
}) {
  const iconSrc = ICON_ASSETS[icon]
  if (iconSrc) {
    return <img src={iconSrc} alt="" className={className} />
  }
  const Icon = ICON_COMPONENTS[icon]
  return Icon ? <Icon className={className} aria-hidden={true} /> : null
}
