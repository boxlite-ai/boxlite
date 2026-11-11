/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { themes } from 'prism-react-renderer'
import { describe, expect, it } from 'vitest'
import { contrastRatio, readableCodeTheme, readableOn } from './readable-code-theme'

const LIGHT_SURFACE = '#fafafa'
const DARK_SURFACE = '#121212'

describe('contrastRatio', () => {
  it('matches the WCAG reference values', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5)
    // The stock oneLight string colour on the code surface: the defect this module fixes.
    expect(contrastRatio('hsl(119, 34%, 47%)', LIGHT_SURFACE)).toBeLessThan(4.5)
  })

  it('reads the hsl form the Prism themes use', () => {
    // hsl(0, 0%, 0%) is black and hsl(0, 100%, 50%) is pure red (#ff0000, 4.0:1 on white).
    expect(contrastRatio('hsl(0, 0%, 0%)', '#ffffff')).toBeCloseTo(21, 5)
    expect(contrastRatio('hsl(0, 100%, 50%)', '#ffffff')).toBeCloseTo(3.998, 2)
  })

  it('reports null for a colour it cannot parse', () => {
    expect(contrastRatio('rgb(0, 0, 0)', '#ffffff')).toBeNull()
  })
})

describe('readableOn', () => {
  it('darkens a colour that is too light for a light surface', () => {
    const fixed = readableOn('#50a14f', LIGHT_SURFACE)
    expect(fixed).not.toBe('#50a14f')
    expect(contrastRatio(fixed, LIGHT_SURFACE)).toBeGreaterThanOrEqual(4.5)
  })

  it('lightens a colour that is too dark for a dark surface', () => {
    const fixed = readableOn('#5c6370', DARK_SURFACE)
    expect(contrastRatio(fixed, DARK_SURFACE)).toBeGreaterThanOrEqual(4.5)
  })

  it('leaves a colour that already passes exactly as it was', () => {
    expect(readableOn('#1a1a1a', LIGHT_SURFACE)).toBe('#1a1a1a')
  })

  it('stops at the first step that passes, not at black', () => {
    const fixed = readableOn('#50a14f', LIGHT_SURFACE)
    expect(fixed).not.toBe('#000000')
    expect(contrastRatio(fixed, LIGHT_SURFACE)).toBeLessThan(5.2)
  })

  it('returns an unparseable colour unchanged', () => {
    expect(readableOn('inherit', LIGHT_SURFACE)).toBe('inherit')
  })
})

describe('readableCodeTheme', () => {
  it.each([
    ['oneLight', themes.oneLight, LIGHT_SURFACE],
    ['oneDark', themes.oneDark, DARK_SURFACE],
  ])('brings every %s token colour to 4.5:1', (_name, theme, surface) => {
    const readable = readableCodeTheme(theme, surface)
    const colors = [readable.plain.color, ...readable.styles.map((entry) => entry.style.color)].filter(
      (color): color is string => typeof color === 'string' && color.startsWith('#'),
    )
    expect(colors.length).toBeGreaterThan(5)
    for (const color of colors) {
      expect(contrastRatio(color, surface), color).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('clears the theme background so the console surface shows through', () => {
    expect(readableCodeTheme(themes.oneLight, LIGHT_SURFACE).plain.backgroundColor).toBe('transparent')
  })
})
