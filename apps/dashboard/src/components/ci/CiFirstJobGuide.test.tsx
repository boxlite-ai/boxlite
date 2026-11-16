// @vitest-environment jsdom
/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { copyToClipboard } from '@/lib/copy-text'
import { CiFirstJobGuide } from './CiFirstJobGuide'
vi.mock('@/lib/copy-text', () => ({ copyToClipboard: vi.fn() }))
describe('CI first job guide', () => {
  let root: Root
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
  })
  afterEach(async () => {
    await act(async () => root?.unmount())
    document.body.innerHTML = ''
  })
  async function render(props: React.ComponentProps<typeof CiFirstJobGuide> = {}) {
    const host = document.createElement('div')
    document.body.append(host)
    await act(async () => {
      root = createRoot(host)
      root.render(
        <MemoryRouter>
          <CiFirstJobGuide {...props} />
        </MemoryRouter>,
      )
    })
    await act(async () => document.querySelector<HTMLButtonElement>('button')!.click())
  }
  const button = (text: string) => [...document.querySelectorAll('button')].find((el) => el.textContent === text)!
  it('starts with the job configuration and keeps optional workflow and diagnostics collapsed', async () => {
    vi.mocked(copyToClipboard).mockResolvedValue(true)
    await render()
    expect(document.querySelector('[aria-label="Workflow YAML"]')).toBeNull()
    expect(document.querySelector('del')?.textContent).toContain('runs-on: ubuntu-latest')
    expect(document.querySelector('ins')?.textContent).toContain('runs-on: boxlite')
    expect(document.body.textContent).toContain('Example')
    expect(document.body.textContent).toContain('No BoxLite API key required')
    await act(async () => button('Copy runs-on').click())
    expect(copyToClipboard).toHaveBeenCalledWith('runs-on: boxlite')
  })
  it('copies the displayed workflow without implying execution or closing the guide', async () => {
    vi.mocked(copyToClipboard).mockResolvedValue(true)
    await render()
    await act(async () =>
      [...document.querySelectorAll('summary')].find((e) => e.textContent === 'Try a test workflow')!.click(),
    )
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
    const code = document.querySelector('[aria-label="Workflow YAML"] code')!.textContent!
    expect(code).toContain('runs-on: boxlite')
    expect(code).toContain('workflow_dispatch:')
    expect(code).toContain('permissions: {}')
    expect(code).not.toContain('uses:')
    expect(document.body.textContent).toContain('After committing the file to your default branch')
    expect(document.body.textContent).toContain('The example above is named BoxLite connection test')
    expect(document.querySelector('a[href="/dashboard/ci"]')).toBeNull()
    await act(async () => button('Copy workflow').click())
    expect(copyToClipboard).toHaveBeenCalledWith(code)
    expect(button('Copied')).toBeDefined()
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    expect(document.body.textContent).not.toContain('Job completed')
  })
  it('keeps selectable YAML and inline recovery after a clipboard failure', async () => {
    vi.mocked(copyToClipboard).mockResolvedValue(false)
    await render()
    await act(async () => button('Copy runs-on').click())
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Select and copy')
    expect([...document.querySelectorAll('pre code')].at(-1)?.textContent).toBe('runs-on: boxlite')
  })
})
