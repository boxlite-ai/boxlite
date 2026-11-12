/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { LogoText } from '@/assets/Logo'
import { BoxCube } from '@/components/BoxCube'
import { useEffect, useState } from 'react'

/**
 * The wait, said once — as a box.
 *
 * This screen used to announce "BOOTING CONSOLE" in 17px letterspaced caps:
 * the loudest thing on it, narrating the wait rather than filling it, and not
 * true besides (a bundle is arriving, nothing is booting). Three loops ran at
 * once — a pulsing square, its glow, and a cycling ellipsis — none of which
 * said anything about what this product is.
 *
 * What it is, is boxes. So the wait is one assembling: three faces drawing in,
 * the top catching the light when they meet. The wording lives in `sr-only`
 * text, where an assistive reader needs it and a sighted reader does not.
 */
const LoadingFallback = () => {
  const [slow, setSlow] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 5_000)
    return () => clearTimeout(timer)
  }, [])

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-svh flex-col items-center justify-center gap-7 bg-background px-6 text-center font-sans text-foreground"
    >
      <BoxCube state="building" size={76} className="text-foreground" />
      <LogoText className="h-9 w-auto" />
      <span className="sr-only">Loading the console</span>

      {/* Height is reserved: a message that appears only sometimes should not
          move the logo when it does. */}
      <p
        className={`h-4 text-meta text-muted-foreground transition-opacity duration-500 ${slow ? 'opacity-100' : 'opacity-0'}`}
      >
        still loading — ping{' '}
        <a href="mailto:support@boxlite.ai" className="underline underline-offset-2 hover:text-foreground">
          support@boxlite.ai
        </a>{' '}
        if this sticks
      </p>
    </div>
  )
}

export default LoadingFallback
