/*
 * Modified by BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The console's visual language, held as a number that may only go down.
 *
 * Square corners and flat surfaces are load-bearing; the type scale is six
 * named sizes. All three were being eroded one `rounded-md`, one `shadow`, one
 * `text-[11.5px]` at a time — each invisible in review because the tailwind
 * config zeroes every radius token, so the code kept saying one thing while
 * the screen showed another. These counts are the current debt. A change may
 * pay it down; it may not add to it. Lower the ceiling when you do.
 */
const SRC = join(__dirname)

const RULES = [
  {
    name: 'arbitrary font sizes (use text-label/meta/body/em/section/page)',
    pattern: /\btext-\[\d+(?:\.\d+)?px\]/g,
    ceiling: 290,
  },
  { name: 'rounded corners (the language is square)', pattern: /\brounded-(?:sm|md|lg|xl|2xl|3xl)\b/g, ceiling: 64 },
  {
    name: 'resting shadows (shadow is for floating overlays only)',
    pattern: /(?<![-\w])shadow(?:-(?:xs|sm|md|lg|xl|card))?(?=[\s'"`])/g,
    ceiling: 17,
  },
] as const

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return name === 'mocks' ? [] : sourceFiles(full)
    if (!/\.tsx?$/.test(name) || /\.(test|stories)\.tsx?$/.test(name)) return []
    return [full]
  })
}

describe('design language', () => {
  const files = sourceFiles(SRC)

  for (const rule of RULES) {
    it(`does not grow: ${rule.name}`, () => {
      const hits: string[] = []
      for (const file of files) {
        const text = readFileSync(file, 'utf8')
        const n = (text.match(rule.pattern) ?? []).length
        if (n > 0) hits.push(`${relative(SRC, file)} ×${n}`)
      }
      const total = hits.reduce((sum, h) => sum + Number(h.split('×')[1]), 0)
      expect(
        total,
        `${total} uses (ceiling ${rule.ceiling}). Worst offenders:\n${hits
          .sort((a, b) => Number(b.split('×')[1]) - Number(a.split('×')[1]))
          .slice(0, 8)
          .join('\n')}`,
      ).toBeLessThanOrEqual(rule.ceiling)
    })
  }
})
