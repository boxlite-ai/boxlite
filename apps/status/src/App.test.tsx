// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import App from './App'

const generatedAt = new Date().toISOString()

function response() {
  return new Response(
    JSON.stringify({
      schemaVersion: 1,
      generatedAt,
      regions: [
        {
          id: 'ap-southeast-1',
          status: 'operational',
          services: [
            { id: 'api', name: 'API', status: 'operational' },
            { id: 'runner', name: 'Runner', status: 'operational' },
            { id: 'proxy', name: 'Proxy', status: 'operational' },
          ],
        },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

describe('standalone status page', () => {
  let root: Root | null = null

  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.innerHTML = ''
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('renders API, Runner, and Proxy below their AWS region and supports collapsing them', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response()))
    const host = document.createElement('div')
    document.body.appendChild(host)

    await act(async () => {
      root = createRoot(host)
      root.render(<App />)
    })

    expect(host.textContent).toContain('ap-southeast-1')
    expect(Array.from(host.querySelectorAll('.service')).map((service) => service.textContent)).toEqual([
      'APIOperational',
      'RunnerOperational',
      'ProxyOperational',
    ])

    const toggle = host.querySelector<HTMLButtonElement>('.region__toggle')
    act(() => toggle?.click())
    expect(toggle?.getAttribute('aria-expanded')).toBe('false')
    expect(host.querySelector('.services')?.hasAttribute('hidden')).toBe(true)
  })

  it('does not retain an operational claim after a refresh error', async () => {
    vi.useFakeTimers()
    const refreshError = new Error('private upstream response body')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchMock = vi.fn().mockResolvedValueOnce(response()).mockRejectedValueOnce(refreshError)
    vi.stubGlobal('fetch', fetchMock)
    const host = document.createElement('div')
    document.body.appendChild(host)

    await act(async () => {
      root = createRoot(host)
      root.render(<App />)
    })
    expect(host.textContent).toContain('Operational')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(host.textContent).toContain('Status unavailable')
    expect(host.textContent).not.toContain('Operational')
    expect(errorSpy).toHaveBeenCalledWith('Failed to refresh public status snapshot', {
      path: '/public-status.json',
      category: 'unavailable',
    })
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(refreshError.message)
  })

  it('expires a cached snapshot even when no refresh completes', async () => {
    vi.useFakeTimers({ now: Date.parse(generatedAt) })
    vi.spyOn(window, 'setInterval').mockReturnValue(0)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response()))
    const host = document.createElement('div')
    document.body.appendChild(host)

    await act(async () => {
      root = createRoot(host)
      root.render(<App />)
    })
    expect(host.textContent).toContain('Operational')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1)
    })
    expect(host.textContent).toContain('Status unavailable')
    expect(host.textContent).not.toContain('Operational')
  })
})
