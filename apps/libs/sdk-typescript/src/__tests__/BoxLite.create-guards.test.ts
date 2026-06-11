/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: Apache-2.0
 */
import { BoxLite } from '../BoxLite'
import { BoxliteError } from '../errors/BoxliteError'

const createStartedBoxDto = () => ({
  id: 'box-uuid',
  boxId: 'box_public',
  name: 'box-name',
  organizationId: 'org-uuid',
  user: 'boxlite',
  env: {},
  labels: {},
  public: false,
  target: 'test',
  cpu: 2,
  gpu: 0,
  memory: 4,
  disk: 10,
  state: 'started',
  recoverable: false,
  networkBlockAll: false,
  toolboxProxyUrl: 'http://127.0.0.1:9999',
})

describe('BoxLite.create image and template guards', () => {
  it('passes curated image keys to the API', async () => {
    const boxlite = new BoxLite({ apiKey: 'test-key', apiUrl: 'http://127.0.0.1:1', target: 'test' })
    const createBox = jest.fn().mockResolvedValue({ data: createStartedBoxDto() })
    ;(boxlite as unknown as { boxApi: { createBox: typeof createBox } }).boxApi.createBox = createBox

    await boxlite.create({ image: 'base' })

    expect(createBox).toHaveBeenCalledWith(expect.objectContaining({ image: 'base' }), undefined, expect.any(Object))
  })

  it('rejects declarative Image object creation', async () => {
    const boxlite = new BoxLite({ apiKey: 'test-key', apiUrl: 'http://127.0.0.1:1', target: 'test' })

    await expect(boxlite.create({ image: {} } as any)).rejects.toThrow(BoxliteError)
    await expect(boxlite.create({ image: {} } as any)).rejects.toThrow('Declarative Image objects are no longer supported')
  })

  it('rejects templateId-based creation', async () => {
    const boxlite = new BoxLite({ apiKey: 'test-key', apiUrl: 'http://127.0.0.1:1', target: 'test' })

    await expect(boxlite.create({ templateId: 'my-template' })).rejects.toThrow(BoxliteError)
    await expect(boxlite.create({ templateId: 'my-template' })).rejects.toThrow('Box templates were removed')
  })
})
