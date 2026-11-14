import { parseFilestoreInstances } from './filestore-instances'

describe('filestore instances configuration', () => {
  it('uses the temporary development default when the variable is unset', () => {
    expect(parseFilestoreInstances({})).toEqual({
      instances: [{ instance: 'boxlite-dev-shared', projectId: 'boxlite-dev-project', zone: 'us-east5-a' }],
    })
  })

  it('accepts an explicit empty variable as a disabled deployment', () => {
    expect(parseFilestoreInstances({ FILESTORE_INSTANCES: '' })).toEqual({ instances: [] })
    expect(parseFilestoreInstances({ FILESTORE_INSTANCES: '   ' })).toEqual({ instances: [] })
  })

  it('trims fields and accepts a valid JSON object list', () => {
    expect(
      parseFilestoreInstances({
        FILESTORE_INSTANCES:
          '[{"instance":" ml-scratch ","project_id":" boxlite-dev ","zone":" asia-southeast1-b "},' +
          '{"instance":"boxlite-dev-shared","project_id":"boxlite-dev-project","zone":"us-east5-a"}]',
      }),
    ).toEqual({
      instances: [
        { instance: 'ml-scratch', projectId: 'boxlite-dev', zone: 'asia-southeast1-b' },
        { instance: 'boxlite-dev-shared', projectId: 'boxlite-dev-project', zone: 'us-east5-a' },
      ],
    })
  })

  it('accepts an explicit empty JSON array as a disabled deployment', () => {
    expect(parseFilestoreInstances({ FILESTORE_INSTANCES: '[]' })).toEqual({ instances: [] })
  })

  it.each([
    'not-json',
    '{"instance":"ml-scratch"}',
    '[{}]',
    '[{"instance":"ML","project_id":"boxlite-dev","zone":"us-east5-a"}]',
    '[{"instance":"ml-scratch","project_id":"BOXLITE","zone":"us-east5-a"}]',
    '[{"instance":"ml-scratch","project_id":"abcde","zone":"us-east5-a"}]',
    '[{"instance":"ml-scratch","project_id":"abcdef-","zone":"us-east5-a"}]',
    '[{"instance":"ml-scratch","project_id":"abcde-fghij-klmno-pqrst-uvwxy-z","zone":"us-east5-a"}]',
    '[{"instance":"ml-scratch","project_id":"boxlite-dev","zone":"us-east5"}]',
    '[{"instance":"ml-scratch","project_id":"boxlite-dev","zone":"asia1-0"}]',
    '[{"instance":"ml-scratch","project_id":"boxlite-dev","zone":"us-east5-a"},' +
      '{"instance":"ml-scratch","project_id":"other-project","zone":"us-east5-b"}]',
  ])('refuses invalid configuration %s', (raw) => {
    expect(() => parseFilestoreInstances({ FILESTORE_INSTANCES: raw })).toThrow('FILESTORE_INSTANCES')
  })
})
