/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestException } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { RequiredOrganizationMemberRole } from '../../organization/decorators/required-organization-member-role.decorator'
import { OrganizationMemberRole } from '../../organization/enums/organization-member-role.enum'
import { BillingPaymentController, PaymentWebhookController } from './payment.controller'

describe('BillingPaymentController', () => {
  const paymentService = {
    getPaymentState: jest.fn(),
    setupPaymentMethod: jest.fn(),
    setAutoReload: jest.fn(),
    createManualTopUp: jest.fn(),
    listReceipts: jest.fn(),
    handleWebhook: jest.fn(),
  }

  beforeEach(() => jest.resetAllMocks())

  it('keeps every customer payment operation owner-only and delegates validated contracts', async () => {
    const controller = new BillingPaymentController(paymentService as never)
    paymentService.getPaymentState.mockResolvedValue({ providerMode: 'fake' })
    paymentService.setupPaymentMethod.mockResolvedValue({ status: 'ready', checkoutUrl: null })
    paymentService.setAutoReload.mockResolvedValue(undefined)
    paymentService.createManualTopUp.mockResolvedValue({ id: 'top-up-1', status: 'paid', checkoutUrl: null })
    paymentService.listReceipts.mockResolvedValue({ items: [], page: 1, pageSize: 8, total: 0 })

    await expect(controller.getPaymentState('org-1')).resolves.toEqual({ providerMode: 'fake' })
    await expect(controller.setupPaymentMethod('org-1')).resolves.toMatchObject({ status: 'ready' })
    await expect(
      controller.setAutoReload('org-1', { enabled: true, thresholdCents: '2000', targetCents: '5000' }),
    ).resolves.toBeUndefined()
    await expect(controller.createTopUp('org-1', { amountCents: '2500' }, 'request-1')).resolves.toMatchObject({
      status: 'paid',
    })
    await expect(controller.listReceipts('org-1', '1', '8', '')).resolves.toMatchObject({ total: 0 })

    expect(paymentService.createManualTopUp).toHaveBeenCalledWith('org-1', '2500', 'request-1')
    const reflector = new Reflector()
    for (const handler of [
      BillingPaymentController.prototype.getPaymentState,
      BillingPaymentController.prototype.setupPaymentMethod,
      BillingPaymentController.prototype.setAutoReload,
      BillingPaymentController.prototype.createTopUp,
      BillingPaymentController.prototype.listReceipts,
    ]) {
      expect(reflector.get(RequiredOrganizationMemberRole, handler)).toBe(OrganizationMemberRole.OWNER)
    }
  })

  it('requires untouched raw bytes and a Stripe signature on the public webhook', async () => {
    const controller = new PaymentWebhookController(paymentService as never)
    const rawBody = Buffer.from('{"id":"evt-1"}')

    await expect(controller.handle({ rawBody } as never, 'signature')).resolves.toEqual({ received: true })
    expect(paymentService.handleWebhook).toHaveBeenCalledWith(rawBody, 'signature')
    await expect(controller.handle({ rawBody: undefined } as never, 'signature')).rejects.toBeInstanceOf(
      BadRequestException,
    )
    await expect(controller.handle({ rawBody } as never, undefined)).rejects.toBeInstanceOf(BadRequestException)
  })
})
