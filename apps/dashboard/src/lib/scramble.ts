/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

// One frame of a left-to-right "decode" reveal, used by the create-box name
// field while a generated name locks in. The first `progress` fraction of
// characters are locked to `target`; the rest are random glyphs from the box-name
// alphabet. progress <= 0 → fully scrambled (same length); progress >= 1 → target.
const GLYPHS = 'abcdefghijklmnopqrstuvwxyz-'

export function scrambleFrame(target: string, progress: number): string {
  const revealed = Math.max(0, Math.min(target.length, Math.floor(progress * target.length)))
  let out = ''
  for (let i = 0; i < target.length; i++) {
    out += i < revealed ? target[i] : GLYPHS[Math.floor(Math.random() * GLYPHS.length)]
  }
  return out
}
