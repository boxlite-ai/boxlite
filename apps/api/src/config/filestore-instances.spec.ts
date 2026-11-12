// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

import { parseFilestoreInstances } from './filestore-instances'

const VALID = JSON.stringify([{ name: 'ml-scratch', server: '10.0.0.7', export: '/vol1' }])

describe('filestore instances configuration', () => {
  it('accepts an unset variable as an empty list', () => {
    expect(parseFilestoreInstances({})).toEqual([])
    expect(parseFilestoreInstances({ FILESTORE_INSTANCES: '' })).toEqual([])
    expect(parseFilestoreInstances({ FILESTORE_INSTANCES: '   ' })).toEqual([])
  })

  it('accepts a valid list', () => {
    expect(parseFilestoreInstances({ FILESTORE_INSTANCES: VALID })).toEqual([
      { name: 'ml-scratch', server: '10.0.0.7', export: '/vol1' },
    ])
  })

  it.each([
    'not json',
    '{"name": "ml"}',
    '[{"name": "ml", "server": "10.0.0.7"}]',
    '[{"name": "ml", "export": "/vol1"}]',
    '[{"server": "10.0.0.7", "export": "/vol1"}]',
    '[{"name": "Bad_Name", "server": "s", "export": "/vol1"}]',
    '[{"name": "-lead", "server": "s", "export": "/vol1"}]',
    '[{"name": "a/b", "server": "s", "export": "/vol1"}]',
    '[{"name": "ml", "server": "s", "export": "/vol1"}, {"name": "ml", "server": "t", "export": "/vol1"}]',
    '[{"name": "ml", "server": "s", "export": "/vol1", "mountOptions": ["vers=3"]}]',
    '[{"name": "ml", "server": "s", "export": "/vol1", "mountOptions": ["nfsvers=4.0"]}]',
    '[{"name": "ml", "server": "s", "export": "/vol1", "mountOptions": ["proto=tcp"]}]',
    '[{"name": "ml", "server": "s", "export": "/vol1", "mountOptions": ["soft"]}]',
    '[{"name": "ml", "server": "s", "export": "/vol1", "mountOptions": ["hard"]}]',
  ])('refuses %s', (raw) => {
    expect(() => parseFilestoreInstances({ FILESTORE_INSTANCES: raw })).toThrow('FILESTORE_INSTANCES')
  })

  it('accepts non-pinned mount options, including whitespace-padded ones', () => {
    const raw = JSON.stringify([{ name: 'ml', server: 's', export: '/vol1', mountOptions: [' ro ', 'rsize=32768'] }])
    expect(parseFilestoreInstances({ FILESTORE_INSTANCES: raw })[0].mountOptions).toEqual([' ro ', 'rsize=32768'])
  })
})
