import { Logger, ServiceUnavailableException } from '@nestjs/common'
import { SecretCredentialService } from './secret-credential.service'

describe('Secret credential database failures', () => {
  const binding = { runnerId: 'runner', boxId: 'box', organizationId: 'org', secretIds: ['secret-id'] }

  it.each(['issue', 'consume', 'replay lookup'])('sanitizes failures during %s', async (operation) => {
    const privateDetail = 'private-driver-parameters'
    const driverError = Object.assign(new Error(privateDetail), { parameters: [privateDetail] })
    const query = jest.fn().mockRejectedValue(driverError)
    if (operation === 'replay lookup') query.mockResolvedValueOnce([[]])
    const service = new SecretCredentialService({ query } as any)
    const log = jest.spyOn(Logger.prototype, 'error').mockImplementation()
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation()
    try {
      const result =
        operation === 'issue' ? service.issue(binding) : service.consume(`bxsc_${'a'.repeat(43)}`, binding.runnerId)
      const error = await result.catch((caught) => caught)
      expect(error).toBeInstanceOf(ServiceUnavailableException)
      expect(error.getStatus()).toBe(503)
      expect(error.message).toBe(
        operation === 'issue' ? 'Could not issue secret credential' : 'Could not consume secret credential',
      )
      expect(error.cause).toBeUndefined()
      expect(JSON.stringify(error)).not.toContain(privateDetail)
      expect(log).not.toHaveBeenCalled()
      expect(warn).not.toHaveBeenCalled()
      expect(query).toHaveBeenCalledTimes(operation === 'replay lookup' ? 2 : 1)
    } finally {
      log.mockRestore()
      warn.mockRestore()
    }
  })
})
