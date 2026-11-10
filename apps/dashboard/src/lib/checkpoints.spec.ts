import { BoxState, type Box } from '@boxlite-ai/api-client'
import { AxiosError, AxiosHeaders } from 'axios'
import { describe, expect, it } from 'vitest'
import {
  checkpointAdmittedBoxId,
  checkpointErrorMessage,
  isCheckpointBoxIdle,
  isCheckpointNameValid,
} from './checkpoints'

function source(overrides: Record<string, unknown> = {}): Box {
  return { state: BoxState.STOPPED, desiredState: BoxState.STOPPED, ...overrides } as Box
}

function httpError(data: unknown) {
  const error = new AxiosError('Network request failed')
  error.response = {
    data,
    status: 408,
    statusText: 'Request Timeout',
    headers: {},
    config: { headers: new AxiosHeaders() },
  }
  return error
}

describe('checkpoint source admission', () => {
  it('accepts stopped sources with no active work or external state', () => {
    expect(isCheckpointBoxIdle(source())).toBe(true)
    expect(isCheckpointBoxIdle(source({ pending: false, volumes: [], secrets: [] }))).toBe(true)
  })

  it.each([
    { state: BoxState.STARTED },
    { desiredState: BoxState.STARTED },
    { pending: true },
    { volumes: [{ id: 'volume-1' }] },
    { secrets: [{ name: 'token' }] },
  ])('refuses an ineligible source: %j', (overrides) => {
    expect(isCheckpointBoxIdle(source(overrides))).toBe(false)
  })
})

describe('checkpoint names', () => {
  it.each(['a', 'base-1.2_dev', 'a'.repeat(128)])('accepts %s', (name) => {
    expect(isCheckpointNameValid(name)).toBe(true)
  })
  it.each(['', '-base', '.base', 'base/name', 'base name', 'a'.repeat(129)])('rejects %s', (name) => {
    expect(isCheckpointNameValid(name)).toBe(false)
  })
})

describe('checkpoint import errors', () => {
  it('extracts structured and flat server messages, including wrapped HTTP errors', () => {
    expect(checkpointErrorMessage(httpError({ error: { message: 'Archive is not ready' } }))).toBe(
      'Archive is not ready',
    )
    expect(checkpointErrorMessage(httpError({ message: 'Box is still starting' }))).toBe('Box is still starting')
    expect(
      checkpointErrorMessage(new Error('Import failed', { cause: httpError({ message: 'Quota exceeded' }) })),
    ).toBe('Quota exceeded')
  })

  it('retains useful client failures when the response has no textual message', () => {
    expect(checkpointErrorMessage(httpError({ message: 408 }))).toBe('Network request failed')
    expect(checkpointErrorMessage(new AxiosError('Connection lost'))).toBe('Connection lost')
    expect(checkpointErrorMessage(new Error('Unexpected failure'))).toBe('Unexpected failure')
    expect(checkpointErrorMessage(null)).toBe('Request failed. Please try again.')
  })

  it('recovers an admitted Box identity from direct and wrapped timeout responses', () => {
    const error = httpError({ boxId: 'accepted-box' })
    expect(checkpointAdmittedBoxId(error)).toBe('accepted-box')
    expect(checkpointAdmittedBoxId(new Error('Import failed', { cause: error }))).toBe('accepted-box')
  })

  it.each([{}, { boxId: '' }, { boxId: 42 }, { box_id: 'wrong-field' }])(
    'does not treat an absent or malformed identity as an admitted Box: %j',
    (body) => {
      expect(checkpointAdmittedBoxId(httpError(body))).toBeUndefined()
    },
  )

  it('does not infer admission from ordinary failures', () => {
    expect(checkpointAdmittedBoxId(new Error('Request failed'))).toBeUndefined()
    expect(checkpointAdmittedBoxId(new AxiosError('Connection lost'))).toBeUndefined()
    expect(checkpointAdmittedBoxId(undefined)).toBeUndefined()
  })
})
