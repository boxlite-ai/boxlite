// @vitest-environment jsdom
/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { PaymentMethodsPanel } from './PaymentMethodsPanel'

it.each([false, true])('prevents repeated card setup while checkout is pending (connected=%s)', (connected) => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const onAction = vi.fn()
  const render = (pending: boolean) =>
    act(() =>
      root.render(
        <PaymentMethodsPanel
          paymentMethods={[]}
          isLoading={false}
          isError
          hasConnectedCard={connected}
          isActionLoading={pending}
          onAction={onAction}
        />,
      ),
    )
  try {
    render(true)
    const button = host.querySelector('button')!
    expect(button.textContent).toContain(connected ? 'Change card' : 'Add card')
    expect(button.disabled).toBe(true)
    act(() => button.click())
    expect(onAction).not.toHaveBeenCalled()
    render(false)
    act(() => button.click())
    expect(onAction).toHaveBeenCalledOnce()
  } finally {
    act(() => root.unmount())
    host.remove()
  }
})
