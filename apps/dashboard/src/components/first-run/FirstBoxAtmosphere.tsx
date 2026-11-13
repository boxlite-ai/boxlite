/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { useEffect, useRef, type ReactNode } from 'react'
import { useTheme } from '@/contexts/ThemeContext'
import './FirstBoxAtmosphere.css'

const FRAME_MS = 1000 / 12
const BOX_PERIOD = 12
const BOX_SITES = [
  [0.1, 0.42, 140, 1.4],
  [0.9, 0.4, 140, 3.6],
  [0.54, 0.93, 170, 6.2],
]
type Point = [number, number]
type BoxSpawn = { x: number; y: number; createdAt: number }
type FormBounds = { left: number; right: number; top: number; bottom: number }
type Surface = { width: number; height: number; form: FormBounds; ink: string; blue: string }
type Plot = (x: number, y: number, char: string, opacity: number, blue?: boolean) => void

function drawBox(plot: Plot, cx: number, cy: number, size: number, age: number) {
  const phase = age / BOX_PERIOD
  if (phase > 0.98) return
  const build = Math.min(1, phase / 0.06)
  const release = Math.max(0, (phase - 0.58) / 0.42)
  const scatter = (1 - build) ** 3 + release ** 2 * 1.6
  const opacity = Math.min(1, build * 2) * (1 - phase * 0.85)
  size *= 0.18 + phase * 1.8
  const scan = ((phase * 3) % 1) * size * 2 - size
  const corners: Point[] = [
    [0, -1],
    [-0.87, -0.5],
    [0.87, -0.5],
    [0, 0],
    [-0.87, 0.5],
    [0.87, 0.5],
    [0, 1],
  ]
  const edges = [
    [0, 1],
    [0, 2],
    [1, 3],
    [2, 3],
    [1, 4],
    [2, 5],
    [3, 6],
    [4, 6],
    [5, 6],
  ]
  const place = (x: number, y: number, alpha: number, blue = false, lineChar?: string) => {
    const seed = x * 5.7 + y * 13.1
    const sx = Math.sin(seed * 2.4) * 95 * scatter
    const sy = Math.cos(seed * 1.7) * 75 * scatter
    const highlight = Math.max(0, 1 - Math.abs(y - scan) / 18)
    const char = scatter > 0.35 ? '.' : lineChar || (highlight > 0.65 ? '*' : blue ? '+' : ':')
    plot(cx + x + sx, cy + y + sy, char, opacity * (alpha + highlight * 0.2), blue)
  }
  // Three visible faces keep the Box recognizable while characters assemble.
  for (const [a, b, d] of [
    [0, 1, 2],
    [1, 3, 4],
    [3, 2, 6],
  ]) {
    for (let u = 0.14; u < 1; u += 0.16) {
      for (let v = 0.14; v < 1; v += 0.16) {
        const x = (corners[a][0] + u * (corners[b][0] - corners[a][0]) + v * (corners[d][0] - corners[a][0])) * size
        const y = (corners[a][1] + u * (corners[b][1] - corners[a][1]) + v * (corners[d][1] - corners[a][1])) * size
        place(x, y, 0.035)
      }
    }
  }
  for (const scale of [1, 0.38]) {
    for (const [a, b] of edges) {
      const dx = corners[b][0] - corners[a][0]
      const dy = corners[b][1] - corners[a][1]
      const char = dx === 0 ? '|' : dx * dy > 0 ? '\\' : '/'
      const steps = Math.ceil((size * scale) / 5)
      for (let i = 0; i <= steps; i++) {
        const t = i / steps
        const x = (corners[a][0] * (1 - t) + corners[b][0] * t) * size * scale
        const y = (corners[a][1] * (1 - t) + corners[b][1] * t) * size * scale
        place(x, y, scale === 1 ? 0.64 : 0.8 * build, scale < 1, i === 0 || i === steps ? '+' : char)
      }
    }
  }
}

function drawBoxes(ctx: CanvasRenderingContext2D, surface: Surface, time: number, spawns: BoxSpawn[]) {
  const { width, height, form, ink, blue } = surface
  ctx.clearRect(0, 0, width, height)
  const cells = new Map<string, { x: number; y: number; char: string; alpha: number; accent: boolean }>()
  const plot: Plot = (px, py, char, opacity, accent = false) => {
    const x = Math.round(px / 8) * 8
    const y = Math.round(py / 12) * 12
    const dx = Math.max(form.left - x, x - form.right, 0)
    const dy = Math.max(form.top - y, y - form.bottom, 0)
    const distance = Math.min(1, Math.hypot(dx, dy) / 80)
    if (distance === 0) return
    const fade = distance * distance * (3 - 2 * distance)
    const edge = Math.max(0, Math.min(1, x / 60, (width - x) / 60, y / 50, (height - y) / 40))
    const alpha = Math.min(0.8, opacity) * fade * edge
    const key = `${x},${y}`
    if (alpha > (cells.get(key)?.alpha ?? 0)) cells.set(key, { x, y, char, alpha, accent })
  }
  for (let y = 12; y < height; y += 24) {
    for (let x = 8; x < width; x += 24) plot(x, y, '.', 0.05)
  }
  for (const [x, y, size, offset] of BOX_SITES) {
    const drift = Math.sin(time * 0.28 + offset) * 8
    for (const delay of [0, 4, 8]) {
      const age = (time + offset + delay) % BOX_PERIOD
      drawBox(plot, x * width, y * height + drift, size, age)
    }
  }
  for (const box of spawns) drawBox(plot, box.x, box.y, 130, time - box.createdAt)
  cells.forEach(({ x, y, char, alpha, accent }) => {
    ctx.fillStyle = `hsl(${accent ? blue : ink} / ${alpha})`
    ctx.fillText(char, x, y)
  })
}

export default function FirstBoxAtmosphere({ children, animated = true }: { children: ReactNode; animated?: boolean }) {
  const root = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const { resolvedTheme } = useTheme()

  useEffect(() => {
    if (!animated) return
    const container = root.current
    const element = canvas.current
    const form = container?.querySelector('main')
    const ctx = element?.getContext('2d')
    if (!container || !element || !ctx || !form) return
    const wide = window.matchMedia('(min-width: 1180px)')
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    let frame = 0
    let previous = 0
    let elapsed = 0
    let surface: Surface
    let spawns: BoxSpawn[] = []

    const paint = () => drawBoxes(ctx, surface, elapsed, spawns)
    const tick = (now: number) => {
      if (now - previous >= FRAME_MS) {
        elapsed += previous ? (now - previous) / 1000 : 0
        previous = now
        spawns = spawns.filter((drop) => elapsed - drop.createdAt < BOX_PERIOD)
        paint()
      }
      frame = requestAnimationFrame(tick)
    }
    const sync = () => {
      cancelAnimationFrame(frame)
      previous = 0
      if (!wide.matches || document.hidden) return
      const bounds = container.getBoundingClientRect()
      const content = form.getBoundingClientRect()
      const density = Math.min(window.devicePixelRatio || 1, 2)
      const style = getComputedStyle(document.documentElement)
      surface = {
        width: bounds.width,
        height: bounds.height,
        form: {
          left: content.left - bounds.left - 10,
          right: content.right - bounds.left + 10,
          top: content.top - bounds.top,
          bottom: content.bottom - bounds.top,
        },
        ink: style.getPropertyValue('--muted-foreground'),
        blue: style.getPropertyValue('--brand'),
      }
      element.width = bounds.width * density
      element.height = bounds.height * density
      ctx.setTransform(density, 0, 0, density, 0, 0)
      ctx.font = `11px ${style.getPropertyValue('--font-mono')}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      paint()
      if (!reduced.matches) frame = requestAnimationFrame(tick)
    }
    const spawnBox = (event: PointerEvent) => {
      if (!wide.matches || reduced.matches || !surface || form.contains(event.target as Node)) return
      const bounds = container.getBoundingClientRect()
      const x = event.clientX - bounds.left
      const y = event.clientY - bounds.top
      spawns = [...spawns.slice(-3), { x, y, createdAt: elapsed }]
    }
    const resize = new ResizeObserver(sync)
    resize.observe(container)
    resize.observe(form)
    // Defer the initial paint until the theme provider has applied its class.
    frame = requestAnimationFrame(sync)
    wide.addEventListener('change', sync)
    reduced.addEventListener('change', sync)
    document.addEventListener('visibilitychange', sync)
    container.addEventListener('pointerdown', spawnBox)
    return () => {
      cancelAnimationFrame(frame)
      resize.disconnect()
      wide.removeEventListener('change', sync)
      reduced.removeEventListener('change', sync)
      document.removeEventListener('visibilitychange', sync)
      container.removeEventListener('pointerdown', spawnBox)
    }
  }, [resolvedTheme, animated])

  return (
    <div ref={root} className="first-box-atmosphere">
      {animated && <canvas ref={canvas} className="first-box-atmosphere__boxes" aria-hidden="true" />}
      {children}
    </div>
  )
}
