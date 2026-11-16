import { setupServer } from 'msw/node'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { BoxState } from '@boxlite-ai/api-client'
import { checkpointHandlers } from './checkpoint-handlers'
import { MOCK_BOXES, buildBox } from './fixtures'

const server = setupServer(...checkpointHandlers)
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())

it('checkpoint preview captures only a source owned by the requested organization', async () => {
  const source = buildBox({
    id: 'foreign-capture-source',
    name: 'foreign-source',
    organizationId: 'source-org',
    state: BoxState.STOPPED,
  })
  MOCK_BOXES.push(source)
  try {
    for (const selector of [source.id, source.name]) {
      const response = await fetch('https://checkpoint-preview.test/v1/other-org/checkpoints', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source_box_id: selector }),
      })
      expect(response.status).toBe(404)
    }
    source.state = BoxState.STARTED
    const running = await fetch('https://checkpoint-preview.test/v1/source-org/checkpoints', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source_box_id: source.id }),
    })
    expect(running.status).toBe(409)
    source.state = BoxState.STOPPED
    const accepted = await fetch('https://checkpoint-preview.test/v1/source-org/checkpoints', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source_box_id: source.id }),
    })
    expect(accepted.status).toBe(201)
    expect(await accepted.json()).toMatchObject({ source_box_id: source.id })
  } finally {
    MOCK_BOXES.splice(MOCK_BOXES.indexOf(source), 1)
  }
})
