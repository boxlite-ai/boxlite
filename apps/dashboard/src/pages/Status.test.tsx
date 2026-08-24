// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

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

  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.innerHTML = ''
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
})
