/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestException } from '@nestjs/common'
import type Stripe from 'stripe'
import { FakePaymentProvider } from './fake-payment.provider'
import { createPaymentProvider } from './payment-provider.factory'
import { StripePaymentProvider } from './stripe-payment.provider'

describe('PaymentProvider implementations', () => {
  it('lets local E2E attach a deterministic fake card and complete payments immediately', async () => {
    const provider = new FakePaymentProvider()

    await expect(
      provider.createSetup({
        organizationId: 'org-1',
        walletId: 'wallet-1',
        setupAttemptId: 'attempt-1',
        providerCustomerId: null,
        successUrl: 'http://dashboard.test/success',
        cancelUrl: 'http://dashboard.test/cancel',
      }),
    ).resolves.toEqual({
      status: 'ready',
      checkoutUrl: null,
      providerReference: 'fake-setup-wallet-1',
      providerCustomerId: 'fake-customer-wallet-1',
      paymentMethod: { id: 'fake-card-wallet-1', brand: 'visa', last4: '4242' },
    })

    await expect(
      provider.createManualTopUp({
        organizationId: 'org-1',
        topUpId: 'top-up-1',
        amountCents: '2500',
        providerCustomerId: 'fake-customer-wallet-1',
        providerMethodId: 'fake-card-wallet-1',
        successUrl: 'http://dashboard.test/success',
        cancelUrl: 'http://dashboard.test/cancel',
      }),
    ).resolves.toMatchObject({ status: 'paid', providerReference: 'fake-payment-top-up-1' })
  })

  it('does not accept public webhook events in fake mode', async () => {
    const provider = new FakePaymentProvider()

    await expect(
      provider.parseWebhook(
        Buffer.from(
          JSON.stringify({
            kind: 'top_up_paid',
            providerEventId: 'forged-event',
            topUpId: 'top-up-1',
            organizationId: 'org-1',
            amountCents: '2500',
            currency: 'usd',
          }),
        ),
        'fake',
      ),
    ).rejects.toBeInstanceOf(BadRequestException)
  })

  it('creates hosted Stripe Checkout sessions with server-owned amount and idempotency metadata', async () => {
    const customersCreate = jest.fn().mockResolvedValue({ id: 'cus_1' })
    const sessionsCreate = jest.fn().mockResolvedValue({ id: 'cs_1', url: 'https://checkout.stripe.test/cs_1' })
    const stripe = {
      customers: { create: customersCreate },
      checkout: { sessions: { create: sessionsCreate } },
    } as unknown as Stripe
    const provider = new StripePaymentProvider('sk_test_secret', 'whsec_test', stripe)

    const setup = await provider.createSetup({
      organizationId: 'org-1',
      walletId: 'wallet-1',
      setupAttemptId: 'attempt-1',
      providerCustomerId: null,
      successUrl: 'https://dashboard.test/success',
      cancelUrl: 'https://dashboard.test/cancel',
    })

    expect(customersCreate).toHaveBeenCalledWith(
      { metadata: { organizationId: 'org-1', walletId: 'wallet-1' } },
      { idempotencyKey: 'wallet-customer:wallet-1' },
    )
    expect(sessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'setup',
        customer: 'cus_1',
        metadata: {
          organizationId: 'org-1',
          walletId: 'wallet-1',
          setupAttemptId: 'attempt-1',
          operation: 'setup',
        },
      }),
      { idempotencyKey: 'wallet-setup:wallet-1:attempt-1' },
    )
    expect(setup).toMatchObject({ status: 'pending', providerCustomerId: 'cus_1', providerReference: 'cs_1' })
  })

  it('passes the trusted top-up amount to Stripe and idempotently confirms saved-card auto-reload', async () => {
    const sessionsCreate = jest.fn().mockResolvedValue({ id: 'cs_topup', url: 'https://checkout.test/topup' })
    const paymentIntentsCreate = jest.fn().mockResolvedValue({
      id: 'pi_auto',
      status: 'succeeded',
      latest_charge: { receipt_url: 'https://receipt.test/auto' },
    })
    const stripe = {
      checkout: { sessions: { create: sessionsCreate } },
      paymentIntents: { create: paymentIntentsCreate },
    } as unknown as Stripe
    const provider = new StripePaymentProvider('sk_test_secret', 'whsec_test', stripe)
    const input = {
      organizationId: 'org-1',
      topUpId: 'top-up-1',
      amountCents: '2500',
      providerCustomerId: 'cus-1',
      providerMethodId: 'pm-1',
      successUrl: 'https://dashboard.test/success',
      cancelUrl: 'https://dashboard.test/cancel',
    }

    await expect(provider.createManualTopUp(input)).resolves.toMatchObject({ status: 'pending' })
    expect(sessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: 'cus-1',
        line_items: [expect.objectContaining({ price_data: expect.objectContaining({ unit_amount: 2500 }) })],
        metadata: expect.objectContaining({ topUpId: 'top-up-1', organizationId: 'org-1' }),
      }),
      { idempotencyKey: 'manual-top-up:top-up-1' },
    )

    await expect(provider.chargeSavedMethod(input)).resolves.toEqual({
      status: 'paid',
      checkoutUrl: null,
      providerReference: 'pi_auto',
      receiptUrl: 'https://receipt.test/auto',
    })
    expect(paymentIntentsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 2500,
        currency: 'usd',
        customer: 'cus-1',
        payment_method: 'pm-1',
        confirm: true,
        off_session: true,
      }),
      { idempotencyKey: 'auto-reload:top-up-1' },
    )
  })

  it('retries ambiguous Stripe errors but records a definitive card failure', async () => {
    const ambiguousError = Object.assign(new Error('connection reset after request'), {
      type: 'StripeConnectionError',
    })
    const cardError = Object.assign(new Error('card declined'), {
      type: 'StripeCardError',
      code: 'card_declined',
      payment_intent: { id: 'pi_declined' },
    })
    const paymentIntentsCreate = jest.fn().mockRejectedValueOnce(ambiguousError).mockRejectedValueOnce(cardError)
    const stripe = { paymentIntents: { create: paymentIntentsCreate } } as unknown as Stripe
    const provider = new StripePaymentProvider('sk_test_secret', 'whsec_test', stripe)
    const input = {
      organizationId: 'org-1',
      topUpId: 'top-up-ambiguous',
      amountCents: '2500',
      providerCustomerId: 'cus-1',
      providerMethodId: 'pm-1',
      successUrl: 'https://dashboard.test/success',
      cancelUrl: 'https://dashboard.test/cancel',
    }

    await expect(provider.chargeSavedMethod(input)).rejects.toBe(ambiguousError)
    await expect(provider.chargeSavedMethod(input)).resolves.toMatchObject({
      status: 'failed',
      providerReference: 'pi_declined',
      failureCode: 'card_declined',
    })
    expect(paymentIntentsCreate).toHaveBeenNthCalledWith(2, expect.any(Object), {
      idempotencyKey: 'auto-reload:top-up-ambiguous',
    })
  })

  it('verifies the original Stripe webhook bytes and maps a paid checkout to a domain event', async () => {
    const payload = Buffer.from('{"id":"evt_1"}')
    const constructEvent = jest.fn().mockReturnValue({
      id: 'evt_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_1',
          mode: 'payment',
          payment_status: 'paid',
          amount_total: 2500,
          currency: 'usd',
          metadata: { topUpId: 'top-up-1', organizationId: 'org-1' },
          payment_intent: null,
        },
      },
    })
    const stripe = { webhooks: { constructEvent } } as unknown as Stripe
    const provider = new StripePaymentProvider('sk_test_secret', 'whsec_test', stripe)

    await expect(provider.parseWebhook(payload, 'stripe-signature')).resolves.toEqual({
      kind: 'top_up_paid',
      providerEventId: 'evt_1',
      providerReference: 'cs_1',
      topUpId: 'top-up-1',
      organizationId: 'org-1',
      amountCents: '2500',
      currency: 'usd',
      receiptUrl: null,
    })
    expect(constructEvent).toHaveBeenCalledWith(payload, 'stripe-signature', 'whsec_test')
  })

  it('accepts the previous webhook secret only during a controlled secret rotation', async () => {
    const payload = Buffer.from('{"id":"evt_rotated"}')
    const signatureError = Object.assign(new Error('signature does not match'), {
      type: 'StripeSignatureVerificationError',
    })
    const constructEvent = jest
      .fn()
      .mockImplementationOnce(() => {
        throw signatureError
      })
      .mockReturnValueOnce({
        id: 'evt_rotated',
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: 'pi_rotated',
            amount_received: 2500,
            currency: 'usd',
            latest_charge: null,
            metadata: { operation: 'auto_reload', topUpId: 'top-up-1', organizationId: 'org-1' },
          },
        },
      })
    const stripe = { webhooks: { constructEvent } } as unknown as Stripe
    const provider = new StripePaymentProvider('sk_test_secret', 'whsec_current', stripe, 'whsec_previous')

    await expect(provider.parseWebhook(payload, 'stripe-signature')).resolves.toMatchObject({
      providerEventId: 'evt_rotated',
      providerReference: 'pi_rotated',
    })
    expect(constructEvent).toHaveBeenNthCalledWith(1, payload, 'stripe-signature', 'whsec_current')
    expect(constructEvent).toHaveBeenNthCalledWith(2, payload, 'stripe-signature', 'whsec_previous')
  })

  it('reserves PaymentIntent webhooks for saved-card auto-reloads', async () => {
    const payload = Buffer.from('{"id":"evt_payment_intent"}')
    const constructEvent = jest
      .fn()
      .mockReturnValueOnce({
        id: 'evt_manual',
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: 'pi_manual',
            amount_received: 2500,
            currency: 'usd',
            latest_charge: null,
            metadata: { operation: 'top_up', topUpId: 'top-up-1', organizationId: 'org-1' },
          },
        },
      })
      .mockReturnValueOnce({
        id: 'evt_auto',
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: 'pi_auto',
            amount_received: 2500,
            currency: 'usd',
            latest_charge: { receipt_url: 'https://receipt.test/auto' },
            metadata: { operation: 'auto_reload', topUpId: 'top-up-2', organizationId: 'org-1' },
          },
        },
      })
    const stripe = { webhooks: { constructEvent } } as unknown as Stripe
    const provider = new StripePaymentProvider('sk_test_secret', 'whsec_test', stripe)

    await expect(provider.parseWebhook(payload, 'stripe-signature')).resolves.toBeNull()
    await expect(provider.parseWebhook(payload, 'stripe-signature')).resolves.toMatchObject({
      kind: 'top_up_paid',
      providerEventId: 'evt_auto',
      providerReference: 'pi_auto',
      topUpId: 'top-up-2',
      receiptUrl: 'https://receipt.test/auto',
    })
  })

  it('reconciles a lost Checkout webhook from the provider source of truth', async () => {
    const sessionsRetrieve = jest.fn().mockResolvedValue({
      id: 'cs_reconcile',
      mode: 'payment',
      status: 'complete',
      payment_status: 'paid',
      amount_total: 2500,
      currency: 'usd',
      metadata: { operation: 'top_up', topUpId: 'top-up-1', organizationId: 'org-1' },
      payment_intent: null,
    })
    const stripe = { checkout: { sessions: { retrieve: sessionsRetrieve } } } as unknown as Stripe
    const provider = new StripePaymentProvider('sk_test_secret', 'whsec_test', stripe)

    await expect(provider.reconcile({ operation: 'top_up', providerReference: 'cs_reconcile' })).resolves.toEqual({
      status: 'resolved',
      event: {
        kind: 'top_up_paid',
        providerEventId: 'reconcile:cs_reconcile:paid',
        providerReference: 'cs_reconcile',
        topUpId: 'top-up-1',
        organizationId: 'org-1',
        amountCents: '2500',
        currency: 'usd',
        receiptUrl: null,
      },
    })
    expect(sessionsRetrieve).toHaveBeenCalledWith('cs_reconcile', { expand: ['payment_intent.latest_charge'] })
  })

  it('keeps processing payments pending and resolves terminal PaymentIntent failures', async () => {
    const paymentIntentsRetrieve = jest
      .fn()
      .mockResolvedValueOnce({
        id: 'pi_processing',
        status: 'processing',
        metadata: { operation: 'auto_reload', topUpId: 'top-up-1', organizationId: 'org-1' },
      })
      .mockResolvedValueOnce({
        id: 'pi_failed',
        status: 'requires_payment_method',
        last_payment_error: { code: 'card_declined', message: 'declined' },
        metadata: { operation: 'auto_reload', topUpId: 'top-up-2', organizationId: 'org-1' },
      })
    const stripe = { paymentIntents: { retrieve: paymentIntentsRetrieve } } as unknown as Stripe
    const provider = new StripePaymentProvider('sk_test_secret', 'whsec_test', stripe)

    await expect(provider.reconcile({ operation: 'top_up', providerReference: 'pi_processing' })).resolves.toEqual({
      status: 'pending',
    })
    await expect(provider.reconcile({ operation: 'top_up', providerReference: 'pi_failed' })).resolves.toEqual({
      status: 'resolved',
      event: expect.objectContaining({
        kind: 'top_up_failed',
        providerEventId: 'reconcile:pi_failed:requires_payment_method',
        failureCode: 'card_declined',
      }),
    })
  })

  it('normalizes refunds and disputes into auditable wallet adjustments', async () => {
    const payload = Buffer.from('{"id":"evt_adjustment"}')
    const constructEvent = jest
      .fn()
      .mockReturnValueOnce({
        id: 'evt_refund',
        type: 'refund.created',
        data: {
          object: {
            id: 're_1',
            amount: 500,
            currency: 'usd',
            status: 'succeeded',
            payment_intent: 'pi_topup',
            charge: null,
          },
        },
      })
      .mockReturnValueOnce({
        id: 'evt_dispute_restored',
        type: 'charge.dispute.funds_reinstated',
        data: {
          object: {
            id: 'du_1',
            amount: 700,
            currency: 'usd',
            payment_intent: 'pi_topup',
            charge: 'ch_1',
          },
        },
      })
    const paymentIntentsRetrieve = jest.fn().mockResolvedValue({
      id: 'pi_topup',
      metadata: { topUpId: 'top-up-1', organizationId: 'org-1' },
    })
    const stripe = {
      webhooks: { constructEvent },
      paymentIntents: { retrieve: paymentIntentsRetrieve },
    } as unknown as Stripe
    const provider = new StripePaymentProvider('sk_test_secret', 'whsec_test', stripe)

    await expect(provider.parseWebhook(payload, 'stripe-signature')).resolves.toEqual({
      kind: 'top_up_adjusted',
      providerEventId: 'evt_refund',
      providerReference: 're_1',
      topUpId: 'top-up-1',
      organizationId: 'org-1',
      amountCents: '500',
      currency: 'usd',
      adjustment: 'refund',
      direction: 'debit',
    })
    await expect(provider.parseWebhook(payload, 'stripe-signature')).resolves.toEqual({
      kind: 'top_up_adjusted',
      providerEventId: 'evt_dispute_restored',
      providerReference: 'du_1',
      topUpId: 'top-up-1',
      organizationId: 'org-1',
      amountCents: '700',
      currency: 'usd',
      adjustment: 'dispute',
      direction: 'restore',
    })
  })

  it('fails closed when production has no explicit provider or Stripe secrets', () => {
    const config = (values: Record<string, unknown>) => ({ get: (key: string) => values[key] }) as never

    expect(() => createPaymentProvider(config({}))).toThrow('unsupported billing payment provider')
    expect(() => createPaymentProvider(config({ 'billing.paymentProvider': 'stripe' }))).toThrow(
      'requires STRIPE_SECRET_KEY',
    )
    expect(createPaymentProvider(config({ 'billing.paymentProvider': 'fake' }))).toBeInstanceOf(FakePaymentProvider)
  })
})
