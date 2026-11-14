import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { BoxliteError } from '@/api/errors'
import { handleApiError } from './error-handling'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

describe('handleApiError', () => {
  beforeEach(() => vi.clearAllMocks())

  it('shows the server reason and non-sensitive diagnostics', () => {
    const error = BoxliteError.fromString('runner has not declared filestore', {
      statusCode: 400,
      code: 'BOX_STATE_TRANSITION_FAILED',
      boxId: 'box-1',
    })

    handleApiError(error, 'Failed to create box')

    expect(toast.error).toHaveBeenCalledWith('Failed to create box', {
      description:
        'runner has not declared filestore · HTTP 400 · Code: BOX_STATE_TRANSITION_FAILED · Box ID: box-1',
      action: undefined,
    })
  })
})
