/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { generateBoxName } from '@boxlite-ai/box-name'
import { scrambleFrame } from '@/lib/scramble'

const REVEAL_MS = 460 // duration of the left-to-right lock-in
const FRAME_MS = 42 // animation tick

// Generates a box name locally (shared @boxlite-ai/box-name lib — the same
// generator the server uses for unnamed creates) and reveals it with a
// "decode" animation, so the name feels handed to the user rather than typed.
// `onName` receives the final name; the dialog stores it as the editable field
// value, not a placeholder.
export function useGeneratedBoxName(onName: (name: string) => void) {
  const [display, setDisplay] = useState('')
  const [isGenerating, setIsGenerating] = useState(false)
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined)
  const onNameRef = useRef(onName)
  onNameRef.current = onName

  const clearTimer = () => {
    if (timer.current) clearInterval(timer.current)
    timer.current = undefined
  }

  const generate = useCallback(() => {
    clearTimer()
    const name = generateBoxName()
    setIsGenerating(true)
    const start = Date.now()
    setDisplay(scrambleFrame(name, 0))
    timer.current = setInterval(() => {
      const progress = Math.min(1, (Date.now() - start) / REVEAL_MS)
      setDisplay(scrambleFrame(name, progress))
      if (progress >= 1) {
        clearTimer()
        setIsGenerating(false)
        onNameRef.current(name)
      }
    }, FRAME_MS)
  }, [])

  const reset = useCallback(() => {
    clearTimer()
    setDisplay('')
    setIsGenerating(false)
  }, [])

  useEffect(() => clearTimer, [])

  return { display, isGenerating, generate, reset }
}
