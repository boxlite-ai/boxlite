// @vitest-environment jsdom
/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { BannerProvider, BannerStack } from './Banner'
import { PageContent, PageHeader, PageLayout, PageTitle } from './PageLayout'

// Keep the real notification components; only remove their animation delay.
const MOTION_ONLY_PROPS = new Set(['layout', 'initial', 'animate', 'exit', 'transition'])
vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
  motion: {
    div: (props: Record<string, unknown>) =>
      createElement('div', Object.fromEntries(Object.entries(props).filter(([key]) => !MOTION_ONLY_PROPS.has(key)))),
  },
}))

describe('Page layout banner interactions', () => {
  let root: Root
  let host: HTMLDivElement

  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  beforeEach(() => {
    host = document.createElement('div')
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
  })

  it.each(['page', 'standalone'] as const)('keeps %s notification actions and dismissal working', (surface) => {
    const onAction = vi.fn()
    const onDismiss = vi.fn()
    act(() =>
      root.render(
        <BannerProvider
          defaultNotifications={[
            {
              id: 'billing-warning',
              variant: 'warning',
              title: 'Balance low',
              description: 'Add funds to keep boxes running.',
              action: { label: 'Open wallet', onClick: onAction },
              onDismiss,
            },
          ]}
        >
          {surface === 'page' ? (
            <PageLayout>
              <PageHeader>
                <PageTitle>Wallet</PageTitle>
              </PageHeader>
              <PageContent>Wallet details</PageContent>
            </PageLayout>
          ) : (
            <BannerStack />
          )}
        </BannerProvider>,
      ),
    )

    const alert = host.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('Balance low')
    expect(alert?.textContent).toContain('Add funds to keep boxes running.')
    const action = Array.from(alert?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent === 'Open wallet',
    )
    expect(action).toBeDefined()
    act(() => action?.click())
    expect(onAction).toHaveBeenCalledOnce()
    expect(onDismiss).not.toHaveBeenCalled()

    const dismiss = alert?.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')
    expect(dismiss).not.toBeNull()
    act(() => dismiss?.click())
    expect(onDismiss).toHaveBeenCalledOnce()
    expect(host.querySelector('[role="alert"]')).toBeNull()
    if (surface === 'page') {
      expect(host.querySelector('h1')?.textContent).toBe('Wallet')
      expect(host.querySelector('main')?.textContent).toBe('Wallet details')
    }
  })
})
