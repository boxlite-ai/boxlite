/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxliteError } from '@/api/errors'
import axios, { AxiosInstance } from 'axios'
import {
  AutomaticTopUp,
  OrganizationEmail,
  OrganizationPlan,
  OrganizationWallet,
  PaginatedInvoices,
  Plan,
  PaymentUrl,
  SeriesGranularity,
  UsageFundingBucket,
  WalletTopUpRequest,
} from './types'

export class BillingApiClient {
  private axiosInstance: AxiosInstance

  constructor(apiUrl: string, accessToken: string) {
    this.axiosInstance = axios.create({
      baseURL: apiUrl,
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    })

    this.axiosInstance.interceptors.response.use(
      (response) => {
        return response
      },
      (error) => {
        const errorMessage = error.response?.data?.message || error.response?.data || error.message || String(error)

        throw BoxliteError.fromString(String(errorMessage))
      },
    )
  }

  public async getOrganizationWallet(organizationId: string): Promise<OrganizationWallet> {
    const response = await this.axiosInstance.get(`/organization/${organizationId}/wallet`)
    return response.data
  }

  public async setAutomaticTopUp(organizationId: string, automaticTopUp?: AutomaticTopUp): Promise<void> {
    await this.axiosInstance.put(`/organization/${organizationId}/wallet/automatic-top-up`, automaticTopUp)
  }

  public async getOrganizationBillingPortalUrl(organizationId: string): Promise<string> {
    const response = await this.axiosInstance.get(`/organization/${organizationId}/portal-url`)
    return response.data
  }

  public async getOrganizationCheckoutUrl(organizationId: string): Promise<string> {
    const response = await this.axiosInstance.get(`/organization/${organizationId}/checkout-url`)
    return response.data
  }

  public async redeemCoupon(organizationId: string, couponCode: string): Promise<string> {
    const response = await this.axiosInstance.post(`/organization/${organizationId}/redeem-coupon/${couponCode}`)
    return response.data?.message || 'Coupon redeemed successfully'
  }

  public async getOrganizationPlan(organizationId: string): Promise<OrganizationPlan | null> {
    const response = await this.axiosInstance.get(`/organization/${organizationId}/plan`)
    if (!response.data) {
      return null
    }
    return {
      ...response.data,
      cycleFrom: new Date(response.data.cycleFrom),
      cycleTo: new Date(response.data.cycleTo),
      ...(response.data.dueAt && { dueAt: new Date(response.data.dueAt) }),
    }
  }

  public async getUsageFundingSeries(
    organizationId: string,
    granularity: SeriesGranularity,
    from: Date,
    to: Date,
  ): Promise<UsageFundingBucket[]> {
    const params = new URLSearchParams({ granularity, from: from.toISOString(), to: to.toISOString() })
    const response = await this.axiosInstance.get(`/organization/${organizationId}/usage/series?${params}`)
    return (
      response.data as Array<{ from: string; to: string; quotaCoveredCents: number; fromWalletCents: number }>
    ).map((bucket) => ({ ...bucket, from: new Date(bucket.from), to: new Date(bucket.to) }))
  }

  /**
   * A first subscribe has no Stripe Subscription to update in place, so the
   * server sends back a Checkout URL to visit instead of applying the change
   * here; an in-place change on an existing subscription applies immediately
   * and returns nothing. Callers must check for a URL before assuming done.
   */
  public async upgradePlan(organizationId: string, planId: string): Promise<string | undefined> {
    const response = await this.axiosInstance.post(`/organization/${organizationId}/plan/upgrade`, { planId })
    return response.data?.url
  }

  public async downgradePlan(organizationId: string, planId: string | null): Promise<void> {
    await this.axiosInstance.post(`/organization/${organizationId}/plan/downgrade`, { planId })
  }

  public async listPlans(): Promise<Plan[]> {
    const response = await this.axiosInstance.get('/plan')
    return response.data
  }

  public async listOrganizationEmails(organizationId: string): Promise<OrganizationEmail[]> {
    const response = await this.axiosInstance.get(`/organization/${organizationId}/email`)
    return response.data.map((email: any) => ({
      ...email,
      verifiedAt: email.verifiedAt ? new Date(email.verifiedAt) : undefined,
    }))
  }

  public async addOrganizationEmail(organizationId: string, email: string): Promise<void> {
    await this.axiosInstance.post(`/organization/${organizationId}/email`, { email })
  }

  public async deleteOrganizationEmail(organizationId: string, email: string): Promise<void> {
    await this.axiosInstance.delete(`/organization/${organizationId}/email`, { data: { email } })
  }

  public async verifyOrganizationEmail(organizationId: string, email: string, token: string): Promise<void> {
    await this.axiosInstance.post(`/organization/${organizationId}/email/verify`, { email, token })
  }

  public async resendOrganizationEmailVerification(organizationId: string, email: string): Promise<void> {
    await this.axiosInstance.post(`/organization/${organizationId}/email/resend`, { email })
  }

  public async listInvoices(organizationId: string, page?: number, perPage?: number): Promise<PaginatedInvoices> {
    const params = new URLSearchParams()
    if (page !== undefined) {
      params.append('page', page.toString())
    }
    if (perPage !== undefined) {
      params.append('perPage', perPage.toString())
    }
    const queryString = params.toString()
    const url = `/organization/${organizationId}/invoices${queryString ? `?${queryString}` : ''}`
    const response = await this.axiosInstance.get(url)
    return response.data
  }

  public async createInvoicePaymentUrl(organizationId: string, invoiceId: string): Promise<PaymentUrl> {
    const response = await this.axiosInstance.post(`/organization/${organizationId}/invoices/${invoiceId}/payment-url`)
    return response.data
  }

  public async voidInvoice(organizationId: string, invoiceId: string): Promise<void> {
    await this.axiosInstance.post(`/organization/${organizationId}/invoices/${invoiceId}/void`)
  }

  public async topUpWallet(organizationId: string, amountCents: number): Promise<PaymentUrl> {
    const response = await this.axiosInstance.post(`/organization/${organizationId}/wallet/top-up`, {
      amountCents,
    } as WalletTopUpRequest)
    return response.data
  }
}
