// @vitest-environment jsdom
/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CiInlineSetup } from './CiInlineSetup'
import { FIRST_JOB_WORKFLOW } from './CiFirstJobGuide'
import { copyToClipboard } from '@/lib/copy-text'
vi.mock('@/lib/copy-text', () => ({ copyToClipboard: vi.fn().mockResolvedValue(true) }))
let root: Root
async function render(connected: boolean) {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const host = document.createElement('div')
  document.body.append(host)
  await act(async () => {
    root = createRoot(host)
    root.render(
      <MemoryRouter>
        <CiInlineSetup connected={connected} />
      </MemoryRouter>,
    )
  })
}
afterEach(async () => {
  await act(async () => root.unmount())
  document.body.innerHTML = ''
  vi.clearAllMocks()
})
describe('CI inline setup', () => {
  it('keeps disconnected setup on the real Connects route in a new tab', async () => {
    await render(false)
    const link = document.querySelector('a')!
    expect(link.getAttribute('href')).toBe('/dashboard/ci/connects')
    expect(link.target).toBe('_blank')
    expect(document.querySelector('ins')?.textContent).toContain('runs-on: boxlite')
    const steps = document.querySelector('ol[aria-label="CI setup steps"]')!
    expect(steps.children).toHaveLength(2)
    expect([...steps.querySelectorAll('h2')].map((heading) => heading.textContent)).toEqual([
      'Step 1: Connect GitHub to get started',
      'Step 2: Update your workflow',
    ])
    expect(document.body.textContent).not.toContain('No active runners')
  })
  it('keeps connected empty inventory distinct from workflow help', async () => {
    await render(true)
    expect(document.body.textContent).toContain('No active runners')
    const details = document.querySelector('details')!
    expect(details.open).toBe(true)
    await act(async () => document.querySelector('summary')!.click())
    expect(details.open).toBe(false)
    expect(document.body.textContent).not.toContain('Job completed')
    expect(document.querySelector('a')?.textContent).toContain('Check repository access')
  })
  it('copies only the replacement runner label without certifying a run', async () => {
    await render(true)
    const copy = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Copy runs-on')!
    await act(async () => copy.click())
    expect(copyToClipboard).toHaveBeenCalledWith('runs-on: boxlite')
    expect(copy.textContent).toBe('Copied')
    expect(document.body.textContent).toContain('No active runners')
  })
  it('expands only the requested help inline without repeating the setup guide', async () => {
    await render(false)
    expect(document.body.textContent).not.toContain('CI jobs use billable compute.')
    expect(document.querySelectorAll('pre')).toHaveLength(1)
    const summary = [...document.querySelectorAll('summary')].find(
      (item) => item.textContent === 'Try a test workflow',
    )!
    await act(async () => {
      summary.click()
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.querySelector('pre[aria-label="Test workflow YAML"]')?.textContent).toBe(FIRST_JOB_WORKFLOW)
    const copy = [...document.querySelectorAll('button')].find((item) => item.textContent === 'Copy workflow')!
    await act(async () => copy.click())
    expect(copyToClipboard).toHaveBeenCalledWith(FIRST_JOB_WORKFLOW)
    expect(document.querySelectorAll('ins')).toHaveLength(1)
  })
})
