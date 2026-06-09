/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import boxliteIconBlack from './boxlite-icon-black.png'
import boxliteIconLight from './boxlite-icon-light.png'
import boxliteLogoBlack from './boxlite-black.png'
import boxliteLogoLight from './boxlite-light.png'

type LogoProps = {
  className?: string
  decorative?: boolean
}

type LogoTextProps = {
  className?: string
}

export function Logo({ className = 'h-7 w-7', decorative = false }: LogoProps) {
  const imageProps = decorative ? { alt: '', 'aria-hidden': true } : { alt: 'BoxLite' }

  return (
    <span className="inline-flex items-center justify-center">
      <img {...imageProps} src={boxliteIconBlack} className={`block ${className} object-contain dark:hidden`} />
      <img {...imageProps} src={boxliteIconLight} className={`hidden ${className} object-contain dark:block`} />
    </span>
  )
}

export function LogoText({ className = 'h-9 w-auto' }: LogoTextProps = {}) {
  const imageClassName = `${className} object-contain`

  return (
    <span className="inline-flex items-center text-foreground">
      <img src={boxliteLogoBlack} alt="BoxLite" className={`block dark:hidden ${imageClassName}`} />
      <img src={boxliteLogoLight} alt="BoxLite" className={`hidden dark:block ${imageClassName}`} />
    </span>
  )
}
