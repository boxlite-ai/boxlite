/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { PrismTheme } from 'prism-react-renderer'

/** WCAG 2.2 minimum contrast for normal-size text (success criterion 1.4.3). */
const MIN_RATIO = 4.5

type Rgb = [number, number, number]

/** Parses `#rrggbb` and `hsl(h, s%, l%)`, the two forms the Prism themes use. */
function parseColor(color: string): Rgb | null {
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim())
  if (hex) {
    const value = parseInt(hex[1], 16)
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
  }
  const hsl = /^hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)$/i.exec(color.trim())
  if (!hsl) return null
  const hue = Number(hsl[1]) / 360
  const saturation = Number(hsl[2]) / 100
  const lightness = Number(hsl[3]) / 100
  if (saturation === 0) return [lightness * 255, lightness * 255, lightness * 255]
  const q = lightness < 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation
  const p = 2 * lightness - q
  const channel = (t: number) => {
    const wrapped = (t + 1) % 1
    if (wrapped < 1 / 6) return p + (q - p) * 6 * wrapped
    if (wrapped < 1 / 2) return q
    if (wrapped < 2 / 3) return p + (q - p) * (2 / 3 - wrapped) * 6
    return p
  }
  return [channel(hue + 1 / 3) * 255, channel(hue) * 255, channel(hue - 1 / 3) * 255]
}

function toHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`
}

function luminance([r, g, b]: Rgb): number {
  const channel = (value: number) => {
    const scaled = value / 255
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/** WCAG contrast ratio between two colours, or `null` when either cannot be parsed. */
export function contrastRatio(foreground: string, background: string): number | null {
  const fg = parseColor(foreground)
  const bg = parseColor(background)
  if (!fg || !bg) return null
  const [lighter, darker] = [luminance(fg), luminance(bg)].sort((a, b) => b - a)
  return (lighter + 0.05) / (darker + 0.05)
}

/**
 * The closest colour to `color` that reaches 4.5:1 on `surface`.
 *
 * It moves in small steps toward black on a light surface and toward white on a dark one, so the
 * hue survives and a colour that already passes comes back unchanged. Colours it cannot parse are
 * returned as they are.
 */
export function readableOn(color: string, surface: string): string {
  const start = parseColor(color)
  const bg = parseColor(surface)
  if (!start || !bg) return color
  const target: Rgb = luminance(bg) > 0.5 ? [0, 0, 0] : [255, 255, 255]
  for (let step = 0; step <= 50; step += 1) {
    const mix = step / 50
    const candidate = start.map((channel, i) => channel + (target[i] - channel) * mix) as Rgb
    const hex = toHex(candidate)
    if ((contrastRatio(hex, surface) ?? 0) >= MIN_RATIO) return hex
  }
  return toHex(target)
}

/**
 * A Prism theme whose token colours all reach 4.5:1 on the code surface it is drawn on.
 *
 * The stock themes are tuned for their own backgrounds: on the console's surfaces their comment,
 * string and number colours sit near 3:1. The background is cleared because the console draws the
 * surface itself.
 */
export function readableCodeTheme(theme: PrismTheme, surface: string): PrismTheme {
  const fix = (color: string | undefined) => (color ? readableOn(color, surface) : color)
  return {
    ...theme,
    plain: { ...theme.plain, color: fix(theme.plain.color), background: 'transparent', backgroundColor: 'transparent' },
    styles: theme.styles.map((entry) => ({ ...entry, style: { ...entry.style, color: fix(entry.style.color) } })),
  }
}
