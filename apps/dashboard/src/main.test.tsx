// @vitest-environment jsdom

import { act, type ReactNode } from 'react'
import { beforeAll, describe, expect, it, vi } from 'vitest'

function PassThrough({ children }: { children: ReactNode }) {
  return children
}

vi.mock('nuqs/adapters/react-router/v6', () => ({ NuqsAdapter: PassThrough }))
vi.mock('./App', () => ({ default: () => <div>Dashboard application</div> }))
vi.mock('./components/PostHogProviderWrapper', () => ({ PostHogProviderWrapper: PassThrough }))
vi.mock('./contexts/ThemeContext', () => ({ ThemeProvider: PassThrough }))
vi.mock('./pages/Status', () => ({ default: () => <div>Public status page</div> }))
vi.mock('./providers/ConfigProvider', () => ({ ConfigProvider: PassThrough }))
vi.mock('./providers/QueryProvider', () => ({ QueryProvider: PassThrough }))

describe('public status routing', () => {
  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  it('serves the public status page when the URL has a trailing slash', async () => {
    document.body.innerHTML = '<div id="root"></div>'
    window.history.replaceState({}, '', '/status/')

    await act(async () => {
      await import('./main')
    })

    expect(document.body.textContent).toContain('Public status page')
    expect(document.body.textContent).not.toContain('Dashboard application')
  })
})
