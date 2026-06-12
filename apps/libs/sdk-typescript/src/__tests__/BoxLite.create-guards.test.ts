/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: Apache-2.0
 */
import { BoxLite } from '../BoxLite'
import { BoxliteError } from '../errors/BoxliteError'

// The API removed image- and template-based box creation; create() must fail
// loudly on those params instead of silently dropping them. Both guards throw
// before any network call, so a dummy config is safe here.
describe('BoxLite.create removed-parameter guards', () => {
  const boxlite = new BoxLite({ apiKey: 'test-key', apiUrl: 'http://127.0.0.1:1', target: 'test' })

  it('rejects image-based creation', async () => {
    await expect(boxlite.create({ image: 'debian:12.9' })).rejects.toThrow(BoxliteError)
    await expect(boxlite.create({ image: 'debian:12.9' })).rejects.toThrow(
      'Image-based box creation is no longer supported',
    )
  })

  it('rejects templateId-based creation', async () => {
    await expect(boxlite.create({ templateId: 'my-template' })).rejects.toThrow(BoxliteError)
    await expect(boxlite.create({ templateId: 'my-template' })).rejects.toThrow('Box templates were removed')
  })
})
