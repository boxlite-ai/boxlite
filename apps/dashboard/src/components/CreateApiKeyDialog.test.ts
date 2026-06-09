import { describe, expect, it } from 'vitest'
import { getCreatedApiKeyCopyButtonLabel } from '@/lib/api-key-dialog'

describe('CreateApiKeyDialog success state', () => {
  it('promotes the API key copy action and confirms after copying the current key', () => {
    const apiKey = 'boxlite_test_api_key'

    expect(getCreatedApiKeyCopyButtonLabel({ copiedText: null, apiKey })).toBe('Copy API Key')
    expect(getCreatedApiKeyCopyButtonLabel({ copiedText: 'different-value', apiKey })).toBe('Copy API Key')
    expect(getCreatedApiKeyCopyButtonLabel({ copiedText: apiKey, apiKey })).toBe('Copied')
  })
})
