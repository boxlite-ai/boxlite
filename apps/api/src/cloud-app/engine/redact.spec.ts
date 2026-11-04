import { redact, secretKindIn } from '@boxlite-ai/cloud-app-shared'
import { generateApiKeyValue } from '../../common/utils/api-key'

describe('Cloud App platform credentials', () => {
  test.each(['live', 'test', 'svc'] as const)(
    'masks %s keys issued with the configured platform prefix',
    (keyClass) => {
      for (const prefix of ['blk', 'custom123']) {
        const key = generateApiKeyValue(prefix, keyClass)
        expect(redact(`Authorization: Bearer ${key}`)).not.toContain(key)
        expect(secretKindIn(key)).toBe('a BoxLite platform key')
      }
    },
  )
})
