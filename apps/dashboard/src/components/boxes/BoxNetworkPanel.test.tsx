// @vitest-environment jsdom
/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { NetworkMode, type NetworkInfo } from '@boxlite-ai/api-client'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { BoxNetworkPanel } from './BoxNetworkPanel'

function network(inbound: NetworkMode, outbound: NetworkMode, allowNet: string[] = []): NetworkInfo {
  return { outbound: { mode: outbound, allow_net: allowNet }, inbound: { mode: inbound, allow_net: [] } }
}

describe('BoxNetworkPanel', () => {
  let container: HTMLDivElement
  let root: Root

  beforeAll(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  function render(info: NetworkInfo | undefined, onToggleInbound = vi.fn(), canManage = true) {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root.render(
        <BoxNetworkPanel network={info} canManage={canManage} onToggleInbound={onToggleInbound} onGetUrl={vi.fn()} />,
      )
    })
    return onToggleInbound
  }

  // Each row is its key, dotted leader, then value; the text reads key then value.
  function row(key: string): string | undefined {
    return [...container.querySelectorAll('div')]
      .map((element) => element.textContent ?? '')
      .find((text) => text.startsWith(key) && !text.includes('network'))
  }

  it('reports both directions, with the outbound allowlist size', () => {
    render(network(NetworkMode.DISABLED, NetworkMode.ENABLED, ['api.openai.com', '10.0.0.0/8']))

    expect(row('outbound')).toBe('outboundenabled · 2 hosts allowed')
    expect(row('inbound')).toBe('inbounddisabled · your organization')
  })

  it('reports enabled inbound and blocked egress', () => {
    render(network(NetworkMode.ENABLED, NetworkMode.DISABLED))

    expect(row('outbound')).toBe('outbounddisabled')
    expect(row('inbound')).toBe('inboundenabled · anyone')
  })

  it('turns inbound access off without asking', () => {
    const onToggleInbound = render(network(NetworkMode.ENABLED, NetworkMode.ENABLED))

    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Inbound access"]')?.click())

    expect(onToggleInbound).toHaveBeenCalledWith(NetworkMode.DISABLED)
  })

  it('shows an unknown policy without a switch', () => {
    render(undefined)

    expect(row('inbound')).toBe('inboundunknown')
    expect(container.querySelector('[aria-label="Inbound access"]')).toBeNull()
  })

  // A url is a tunnel, which needs inbound access; the control says so up front.
  // The tunnel route also needs WRITE_BOXES, which viewers lack.
  it.each([
    [NetworkMode.ENABLED, true, false],
    [NetworkMode.DISABLED, true, true],
    [NetworkMode.ENABLED, false, true],
  ])('with inbound %s and canManage %s, get url disabled is %s', (inbound, canManage, disabled) => {
    render(network(inbound, NetworkMode.ENABLED), vi.fn(), canManage)

    const getUrl = [...container.querySelectorAll('button')].find((button) => button.textContent === 'get url')
    expect(getUrl?.disabled).toBe(disabled)
  })
})
