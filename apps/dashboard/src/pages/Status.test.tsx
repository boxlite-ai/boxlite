// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import Status from './Status'

const queryState = vi.hoisted(() => ({
  data: undefined as
    | {
        schemaVersion: 1
        generatedAt: string
        regions: Array<{
          id: string
          name: string
          status: 'operational'
          services: Array<{ id: string; name: string; status: 'operational' }>
        }>
      }
    | undefined,
  isPending: false,
  isError: false,
}))

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => queryState,
}))

describe('Status', () => {
  let root: Root | null = null
  const generatedAt = Date.parse('2026-08-24T04:00:00.000Z')

  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(generatedAt + 60_000)
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.innerHTML = ''
    vi.useRealTimers()
    queryState.data = undefined
    queryState.isPending = false
    queryState.isError = false
  })

  it('hides retained operational data when a refresh fails', () => {
    queryState.data = {
      schemaVersion: 1,
      generatedAt: '2026-08-24T04:00:00.000Z',
      regions: [
        {
          id: 'ap-southeast-1',
          name: 'Asia Pacific (Singapore)',
          status: 'operational',
          services: [{ id: 'api', name: 'API', status: 'operational' }],
        },
      ],
    }

    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)

    act(() => root?.render(<Status />))
    expect(document.body.textContent).toContain('Operational')

    queryState.isError = true
    act(() => root?.render(<Status />))

    expect(document.body.textContent).toContain('Status unavailable')
    expect(document.body.textContent).not.toContain('Operational')
  })

  it('hides operational data when the cached snapshot expires without a refetch', () => {
    queryState.data = {
      schemaVersion: 1,
      generatedAt: new Date(generatedAt).toISOString(),
      regions: [
        {
          id: 'ap-southeast-1',
          name: 'Asia Pacific (Singapore)',
          status: 'operational',
          services: [{ id: 'api', name: 'API', status: 'operational' }],
        },
      ],
    }

    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)

    act(() => root?.render(<Status />))
    expect(document.body.textContent).toContain('Operational')

    act(() => vi.advanceTimersByTime(4 * 60_000 + 1))

    expect(document.body.textContent).toContain('Status unavailable')
    expect(document.body.textContent).not.toContain('Operational')
  })

  it('expands and collapses the services within a region', () => {
    queryState.data = {
      schemaVersion: 1,
      generatedAt: '2026-08-24T04:00:00.000Z',
      regions: [
        {
          id: 'ap-southeast-1',
          name: 'Asia Pacific (Singapore)',
          status: 'operational',
          services: [{ id: 'api', name: 'Api', status: 'operational' }],
        },
      ],
    }

    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => root?.render(<Status />))

    const regionToggle = document.querySelector<HTMLButtonElement>(
      'button[aria-controls="region-services-ap-southeast-1"]',
    )
    const serviceList = document.getElementById('region-services-ap-southeast-1') as HTMLUListElement

    expect(regionToggle?.getAttribute('aria-expanded')).toBe('true')
    expect(serviceList.hidden).toBe(false)

    act(() => regionToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(regionToggle?.getAttribute('aria-expanded')).toBe('false')
    expect(serviceList.hidden).toBe(true)

    act(() => regionToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(regionToggle?.getAttribute('aria-expanded')).toBe('true')
    expect(serviceList.hidden).toBe(false)
  })
})
