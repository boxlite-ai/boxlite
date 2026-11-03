/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import type { ComponentType } from 'react'
import python from '@/assets/python.svg'
import go from '@/assets/go.svg'
import { RustIcon } from '@/assets/RustIcon'
import typescript from '@/assets/typescript.svg'
import computer from '@/assets/boxlite-icon-light.png'
import node from '@/assets/templates/nodejs.svg'
import nextjs from '@/assets/templates/nextjs.svg'
import astro from '@/assets/templates/astro.svg'
import vite from '@/assets/templates/vitejs.svg'
import playwright from '@/assets/templates/playwright.svg'
import firefox from '@/assets/templates/firefox.svg'
import docker from '@/assets/templates/docker.svg'
import debian from '@/assets/templates/debian.svg'
import expo from '@/assets/templates/expo.svg'
import xfce from '@/assets/templates/xfce.svg'
import chromium from '@/assets/templates/chromium.png'
import lightpanda from '@/assets/templates/lightpanda.png'
import { Container, Globe, FileText, TextSearch, Eye, BookOpen, MemoryStick, Braces } from '@/components/ui/icon'
import jupyter from '@/assets/templates/jupyter.svg'
import scipy from '@/assets/templates/scipy.svg'
import r from '@/assets/templates/r.svg'
import ffmpeg from '@/assets/templates/ffmpeg.svg'
import qdrant from '@/assets/templates/qdrant.svg'
import postgresql from '@/assets/templates/postgresql.svg'
import k6 from '@/assets/templates/k6.svg'
import uv from '@/assets/templates/uv.svg'
import bun from '@/assets/templates/bun.svg'
import apachemaven from '@/assets/templates/apachemaven.svg'
import gnu from '@/assets/templates/gnu.svg'
import { cn } from '@/lib/utils'

const icons: Record<string, { src: string; className?: string }> = {
  python: { src: python },
  uv: { src: uv },
  bun: { src: bun },
  maven: { src: apachemaven },
  gcc: { src: gnu },
  browserless: { src: chromium },
  node: { src: node },
  base: { src: debian },
  linux: { src: debian },
  go: { src: go },
  scipy: { src: scipy },
  r: { src: r },
  ffmpeg: { src: ffmpeg },
  qdrant: { src: qdrant },
  pgvector: { src: postgresql },
  k6: { src: k6 },
  nextjs: { src: nextjs },
  astro: { src: astro, className: 'bg-white/90 p-1' },
  vite: { src: vite },
  typescript: { src: typescript },
  chromium: { src: chromium },
  'playwright-chromium': { src: playwright },
  'playwright-firefox': { src: firefox },
  lightpanda: { src: lightpanda },
  desktop: { src: xfce, className: 'dark:invert' },
  'computer-use': { src: computer },
  expo: { src: expo, className: 'dark:invert' },
  docker: { src: docker },
  fastapi: { src: python },
  sveltekit: { src: node },
  'playwright-webkit': { src: playwright },
  jupyter: { src: jupyter },
  'data-science': { src: python },
  'document-processing': { src: python },
}

// Task pictograms complement brand marks for tools without a bundled logo.
const taskIcons: Record<string, { icon: ComponentType<{ className?: string }>; className: string }> = {
  rust: { icon: RustIcon, className: 'text-orange-400' },
  crawl4ai: { icon: Globe, className: 'text-emerald-400' },
  gotenberg: { icon: FileText, className: 'text-sky-400' },
  tika: { icon: TextSearch, className: 'text-amber-400' },
  ocr: { icon: Eye, className: 'text-teal-400' },
  pandoc: { icon: BookOpen, className: 'text-rose-400' },
  valkey: { icon: MemoryStick, className: 'text-cyan-400' },
  wiremock: { icon: Braces, className: 'text-lime-400' },
}

export function TemplateIcon({ id }: { id: string }) {
  const task = taskIcons[id]
  if (task) {
    const Icon = task.icon
    return (
      <span aria-hidden="true" className="inline-flex size-7 shrink-0">
        <Icon className={cn('size-7', task.className)} />
      </span>
    )
  }
  const icon = icons[id]
  return icon ? (
    <img src={icon.src} alt="" aria-hidden className={cn('size-7 shrink-0 object-contain', icon.className)} />
  ) : (
    <Container aria-hidden className="size-7 shrink-0 text-muted-foreground" />
  )
}
