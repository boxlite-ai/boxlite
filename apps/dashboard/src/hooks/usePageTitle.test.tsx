// @vitest-environment jsdom
/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { formatPageTitle, usePageTitle } from './usePageTitle'

function Page({ title }: { title: string | undefined }) {
  usePageTitle(title)
  return null
}

describe('usePageTitle', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    document.title = 'BoxLite'
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('names the tab after the page and keeps the product name', () => {
    act(() => root.render(<Page title="Volumes" />))
    expect(document.title).toBe('Volumes · BoxLite')
  })

  it('follows the page name when it changes', () => {
    act(() => root.render(<Page title="web-api" />))
    act(() => root.render(<Page title="batch-worker" />))
    expect(document.title).toBe('batch-worker · BoxLite')
  })

  it('restores the previous title when the page unmounts', () => {
    document.title = 'Boxes · BoxLite'
    act(() => root.render(<Page title="web-api" />))
    expect(document.title).toBe('web-api · BoxLite')
    act(() => root.render(null))
    expect(document.title).toBe('Boxes · BoxLite')
  })

  it('falls back to the product name while the page name is unknown or blank', () => {
    expect(formatPageTitle(undefined)).toBe('BoxLite')
    expect(formatPageTitle('   ')).toBe('BoxLite')
  })
})
