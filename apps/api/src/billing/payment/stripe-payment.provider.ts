/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import Stripe from 'stripe'
import {
  PaymentMethodView,
  PaymentProvider,
  PaymentSetupInput,
  PaymentSetupResult,
  ProviderWebhookEvent,
  TopUpPaymentInput,
  TopUpPaymentResult,
} from './payment-provider'

export class StripePaymentProvider implements PaymentProvider {
  readonly mode = 'stripe' as const

  constructor(
    secretKey: string,
    private readonly webhookSecret: string,
    private readonly stripe = new Stripe(secretKey),
  ) {}

  async createSetup(input: PaymentSetupInput): Promise<PaymentSetupResult> {
    const providerCustomerId = input.providerCustomerId ?? (await this.createCustomer(input)).id
    const session = await this.stripe.checkout.sessions.create(
      {
        mode: 'setup',
        customer: providerCustomerId,
        payment_method_types: ['card'],
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        metadata: {
          organizationId: input.organizationId,
          walletId: input.walletId,
          operation: 'setup',
        },
      },
      { idempotencyKey: `wallet-setup:${input.walletId}:${input.setupAttemptId}` },
    )
    if (!session.url) {
      throw new Error(`Stripe setup session ${session.id} did not return a checkout URL`)
    }
    return {
      status: 'pending',
      checkoutUrl: session.url,
      providerReference: session.id,
      providerCustomerId,
      paymentMethod: null,
    }
  }

  async createManualTopUp(input: TopUpPaymentInput): Promise<TopUpPaymentResult> {
    const session = await this.stripe.checkout.sessions.create(
      {
        mode: 'payment',
        customer: input.providerCustomerId,
        payment_method_types: ['card'],
        line_items: [
          {
            price_data: {
              currency: 'usd',
              product_data: { name: 'BoxLite wallet top-up' },
              unit_amount: Number(input.amountCents),
            },
            quantity: 1,
          },
        ],
        client_reference_id: input.topUpId,
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        metadata: { organizationId: input.organizationId, topUpId: input.topUpId, operation: 'top_up' },
        payment_intent_data: {
          metadata: { organizationId: input.organizationId, topUpId: input.topUpId, operation: 'top_up' },
        },
      },
      { idempotencyKey: `manual-top-up:${input.topUpId}` },
    )
    if (!session.url) {
      throw new Error(`Stripe payment session ${session.id} did not return a checkout URL`)
    }
    return {
      status: 'pending',
      checkoutUrl: session.url,
      providerReference: session.id,
      receiptUrl: null,
    }
  }

  async chargeSavedMethod(input: TopUpPaymentInput): Promise<TopUpPaymentResult> {
    try {
      const paymentIntent = await this.stripe.paymentIntents.create(
        {
          amount: Number(input.amountCents),
          currency: 'usd',
          customer: input.providerCustomerId,
          payment_method: input.providerMethodId,
          confirm: true,
          off_session: true,
          metadata: { organizationId: input.organizationId, topUpId: input.topUpId, operation: 'auto_reload' },
          expand: ['latest_charge'],
        },
        { idempotencyKey: `auto-reload:${input.topUpId}` },
      )
      if (paymentIntent.status !== 'succeeded') {
        return {
          status: 'failed',
          checkoutUrl: null,
          providerReference: paymentIntent.id,
          receiptUrl: null,
          failureCode: paymentIntent.status,
          failureMessage: 'off-session payment did not succeed',
        }
      }
      return {
        status: 'paid',
        checkoutUrl: null,
        providerReference: paymentIntent.id,
        receiptUrl: this.receiptUrl(paymentIntent.latest_charge),
      }
    } catch (error) {
      const stripeError = error as {
        type?: string
        code?: string
        message?: string
        payment_intent?: { id?: string }
      }
      if (stripeError.type !== 'StripeCardError' || !stripeError.payment_intent?.id) throw error
      return {
        status: 'failed',
        checkoutUrl: null,
        providerReference: stripeError.payment_intent.id,
        receiptUrl: null,
        failureCode: stripeError.code ?? 'card_declined',
        failureMessage: stripeError.message ?? 'off-session payment failed',
      }
    }
  }

  async parseWebhook(payload: Buffer, signature: string): Promise<ProviderWebhookEvent | null> {
    const event = this.stripe.webhooks.constructEvent(payload, signature, this.webhookSecret)

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object
      if (session.mode === 'setup') {
        return this.setupEvent(event.id, session)
      }
      if (session.mode === 'payment' && session.payment_status === 'paid') {
        return this.checkoutPaidEvent(event.id, session)
      }
    }

    if (event.type === 'checkout.session.async_payment_failed') {
      return this.checkoutFailedEvent(event.id, event.data.object)
    }

    if (event.type === 'payment_intent.succeeded' && event.data.object.metadata?.operation === 'auto_reload') {
      return this.paymentIntentPaidEvent(event.id, event.data.object)
    }

    if (event.type === 'payment_intent.payment_failed' && event.data.object.metadata?.operation === 'auto_reload') {
      return this.paymentIntentFailedEvent(event.id, event.data.object)
    }

    return null
  }

  private createCustomer(input: PaymentSetupInput) {
    return this.stripe.customers.create(
      { metadata: { organizationId: input.organizationId, walletId: input.walletId } },
      { idempotencyKey: `wallet-customer:${input.walletId}` },
    )
  }

  private async setupEvent(providerEventId: string, session: Stripe.Checkout.Session): Promise<ProviderWebhookEvent> {
    const organizationId = this.requiredMetadata(session, 'organizationId')
    const customerId = this.objectId(session.customer, 'customer')
    const setupIntent =
      typeof session.setup_intent === 'string'
        ? await this.stripe.setupIntents.retrieve(session.setup_intent)
        : session.setup_intent
    if (!setupIntent) {
      throw new Error(`Stripe setup session ${session.id} has no setup intent`)
    }
    const paymentMethod =
      typeof setupIntent.payment_method === 'string'
        ? await this.stripe.paymentMethods.retrieve(setupIntent.payment_method)
        : setupIntent.payment_method
    if (!paymentMethod || paymentMethod.type !== 'card' || !paymentMethod.card) {
      throw new Error(`Stripe setup session ${session.id} did not attach a card`)
    }
    return {
      kind: 'setup_succeeded',
      providerEventId,
      providerReference: session.id,
      organizationId,
      providerCustomerId: customerId,
      paymentMethod: this.paymentMethodView(paymentMethod),
    }
  }

  private async checkoutPaidEvent(
    providerEventId: string,
    session: Stripe.Checkout.Session,
  ): Promise<ProviderWebhookEvent> {
    const receiptUrl = await this.receiptUrlForPaymentIntent(session.payment_intent)
    return {
      kind: 'top_up_paid',
      providerEventId,
      providerReference: session.id,
      topUpId: this.requiredMetadata(session, 'topUpId'),
      organizationId: this.requiredMetadata(session, 'organizationId'),
      amountCents: String(session.amount_total ?? 0),
      currency: session.currency ?? '',
      receiptUrl,
    }
  }

  private checkoutFailedEvent(providerEventId: string, session: Stripe.Checkout.Session): ProviderWebhookEvent {
    return {
      kind: 'top_up_failed',
      providerEventId,
      providerReference: session.id,
      topUpId: this.requiredMetadata(session, 'topUpId'),
      organizationId: this.requiredMetadata(session, 'organizationId'),
      failureCode: 'async_payment_failed',
      failureMessage: 'Stripe Checkout payment failed',
    }
  }

  private paymentIntentPaidEvent(providerEventId: string, intent: Stripe.PaymentIntent): ProviderWebhookEvent {
    return {
      kind: 'top_up_paid',
      providerEventId,
      providerReference: intent.id,
      topUpId: this.requiredMetadata(intent, 'topUpId'),
      organizationId: this.requiredMetadata(intent, 'organizationId'),
      amountCents: String(intent.amount_received),
      currency: intent.currency,
      receiptUrl: this.receiptUrl(intent.latest_charge),
    }
  }

  private paymentIntentFailedEvent(providerEventId: string, intent: Stripe.PaymentIntent): ProviderWebhookEvent {
    return {
      kind: 'top_up_failed',
      providerEventId,
      providerReference: intent.id,
      topUpId: this.requiredMetadata(intent, 'topUpId'),
      organizationId: this.requiredMetadata(intent, 'organizationId'),
      failureCode: intent.last_payment_error?.code ?? null,
      failureMessage: intent.last_payment_error?.message ?? null,
    }
  }

  private async receiptUrlForPaymentIntent(
    paymentIntent: string | Stripe.PaymentIntent | null,
  ): Promise<string | null> {
    if (!paymentIntent) return null
    const intent =
      typeof paymentIntent === 'string'
        ? await this.stripe.paymentIntents.retrieve(paymentIntent, { expand: ['latest_charge'] })
        : paymentIntent
    return this.receiptUrl(intent.latest_charge)
  }

  private receiptUrl(charge: string | Stripe.Charge | null): string | null {
    return typeof charge === 'object' && charge ? charge.receipt_url : null
  }

  private paymentMethodView(paymentMethod: Stripe.PaymentMethod): PaymentMethodView {
    if (!paymentMethod.card) throw new Error(`Stripe payment method ${paymentMethod.id} is not a card`)
    return { id: paymentMethod.id, brand: paymentMethod.card.brand, last4: paymentMethod.card.last4 }
  }

  private objectId(value: string | { id: string } | null, name: string): string {
    if (typeof value === 'string') return value
    if (value?.id) return value.id
    throw new Error(`Stripe object is missing ${name}`)
  }

  private requiredMetadata(object: { id: string; metadata: Stripe.Metadata }, key: string): string {
    const value = object.metadata?.[key]
    if (!value) throw new Error(`Stripe object ${object.id} is missing metadata.${key}`)
    return value
  }
}
