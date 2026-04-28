/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import bboxLogoDark from './bbox-logo-dark.png'
import bboxLogoLight from './bbox-logo-light.png'

export function Logo() {
  return (
    <span className="inline-flex items-center justify-center">
      <img src={bboxLogoDark} alt="BoxLite" className="block h-7 w-7 dark:hidden" />
      <img src={bboxLogoLight} alt="BoxLite" className="hidden h-7 w-7 dark:block" />
    </span>
  )
}

export function LogoText() {
  return <span className="text-lg font-semibold tracking-tight text-foreground">BoxLite</span>
}
