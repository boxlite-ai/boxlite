import { parseFilestoreInstances } from './filestore-instances'

describe('filestore instances configuration', () => {
  it('returns no instances when the variable is unset', () => {
    expect(parseFilestoreInstances({})).toEqual({ instances: [] })
  })

  it('accepts an explicit empty variable as a disabled deployment', () => {
    expect(parseFilestoreInstances({ FILESTORE_INSTANCES: '' })).toEqual({ instances: [] })
    expect(parseFilestoreInstances({ FILESTORE_INSTANCES: '   ' })).toEqual({ instances: [] })
  })

  it('trims fields and accepts a valid JSON object list', () => {
    expect(
      parseFilestoreInstances({
        FILESTORE_INSTANCES:
          '[{"instance":" ml-scratch ","project_id":" example-project ","zone":" asia-southeast1-b "},' +
          '{"instance":"example-shared","project_id":"other-project","zone":"us-central1-a"}]',
      }),
    ).toEqual({
      instances: [
        { instance: 'ml-scratch', projectId: 'example-project', zone: 'asia-southeast1-b' },
        { instance: 'example-shared', projectId: 'other-project', zone: 'us-central1-a' },
      ],
    })
  })

  it('accepts an explicit empty JSON array as a disabled deployment', () => {
    expect(parseFilestoreInstances({ FILESTORE_INSTANCES: '[]' })).toEqual({ instances: [] })
  })

  it.each(['a', 'a0', 'a-b', `${'a'.repeat(62)}0`])('accepts RFC 1035 instance name %s', (instance) => {
    const raw = JSON.stringify([{ instance, project_id: 'example-project', zone: 'asia-southeast1-b' }])

    expect(parseFilestoreInstances({ FILESTORE_INSTANCES: raw })).toEqual({
      instances: [{ instance, projectId: 'example-project', zone: 'asia-southeast1-b' }],
    })
  })

  it.each(['1scratch', 'scratch-', 'a'.repeat(64)])('rejects invalid RFC 1035 instance name %s', (instance) => {
    const raw = JSON.stringify([{ instance, project_id: 'example-project', zone: 'asia-southeast1-b' }])

    expect(() => parseFilestoreInstances({ FILESTORE_INSTANCES: raw })).toThrow('invalid instance')
  })

  it.each([
    'not-json',
    '{"instance":"ml-scratch"}',
    '[{}]',
    '[{"instance":"ML","project_id":"example-project","zone":"asia-southeast1-b"}]',
    '[{"instance":"ml-scratch","project_id":"EXAMPLE","zone":"asia-southeast1-b"}]',
    '[{"instance":"ml-scratch","project_id":"abcde","zone":"asia-southeast1-b"}]',
    '[{"instance":"ml-scratch","project_id":"abcdef-","zone":"asia-southeast1-b"}]',
    '[{"instance":"ml-scratch","project_id":"abcde-fghij-klmno-pqrst-uvwxy-z","zone":"asia-southeast1-b"}]',
    '[{"instance":"ml-scratch","project_id":"example-project","zone":"asia-southeast1"}]',
    '[{"instance":"ml-scratch","project_id":"example-project","zone":"asia1-0"}]',
    '[{"instance":"ml-scratch","project_id":"example-project","zone":"asia-southeast1-b"},' +
      '{"instance":"ml-scratch","project_id":"other-project","zone":"asia-southeast1-c"}]',
  ])('refuses invalid configuration %s', (raw) => {
    expect(() => parseFilestoreInstances({ FILESTORE_INSTANCES: raw })).toThrow('FILESTORE_INSTANCES')
  })

  it.each(['a', 'ab', 'abc', 'abcd', 'abcde'])('rejects a %s-character project ID', (projectId) => {
    const raw = JSON.stringify([{ instance: 'ml-scratch', project_id: projectId, zone: 'asia-southeast1-b' }])

    expect(() => parseFilestoreInstances({ FILESTORE_INSTANCES: raw })).toThrow('invalid project_id')
  })

  it.each(['abcde1', `${'a'.repeat(29)}1`])('accepts project ID %s', (projectId) => {
    const raw = JSON.stringify([{ instance: 'ml-scratch', project_id: projectId, zone: 'asia-southeast1-b' }])

    expect(parseFilestoreInstances({ FILESTORE_INSTANCES: raw })).toEqual({
      instances: [{ instance: 'ml-scratch', projectId, zone: 'asia-southeast1-b' }],
    })
  })

  it.each(['1abcdef', 'abcdef-'])('rejects a project ID with a leading digit or trailing hyphen', (projectId) => {
    const raw = JSON.stringify([{ instance: 'ml-scratch', project_id: projectId, zone: 'asia-southeast1-b' }])

    expect(() => parseFilestoreInstances({ FILESTORE_INSTANCES: raw })).toThrow('invalid project_id')
  })
})
