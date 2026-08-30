// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { createHmac } from 'node:crypto'

/*
 * An SES SMTP password is not an IAM secret access key: it is that key run through
 * a fixed SigV4 chain, and the SMTP interface rejects the raw key. AWS documents the
 * algorithm rather than exposing an API for it (SES developer guide, "Obtaining Amazon
 * SES SMTP credentials by converting existing AWS credentials"), so a caller that
 * mints its own IAM access key has to do this conversion itself.
 *
 * The chain is keyed by Region, so one access key yields a different SMTP password per
 * region and each is valid only against that region's endpoint.
 */
const DATE = '11111111'
const SERVICE = 'ses'
const TERMINAL = 'aws4_request'
const MESSAGE = 'SendRawEmail'
const VERSION = 0x04

export function sesSmtpPasswordV4(secretAccessKey: string, region: string): string {
  if (!secretAccessKey) throw new Error('an SES SMTP password needs a non-empty secret access key')
  if (!region) throw new Error('an SES SMTP password needs the region it will be used in')

  const sign = (key: Buffer, message: string) => createHmac('sha256', key).update(message, 'utf8').digest()

  let signature = sign(Buffer.from(`AWS4${secretAccessKey}`, 'utf8'), DATE)
  for (const step of [region, SERVICE, TERMINAL, MESSAGE]) signature = sign(signature, step)

  return Buffer.concat([Buffer.from([VERSION]), signature]).toString('base64')
}

export type SesProductionAccess =
  | { state: 'granted' }
  | { state: 'pending'; caseId?: string }
  | { state: 'closed'; status: string; caseId?: string }
  | { state: 'request' }

/*
 * What, if anything, to ask AWS for — decided from `sesv2 get-account` rather than
 * from whether this bootstrap has run before.
 *
 * PutAccountDetails is submit-once. A second call while a review is open is refused,
 * and — established against a real DENIED review rather than assumed — so is a call
 * after one closes: AWS answers ConflictException instead of opening a fresh review.
 * A denial is worked through the support case it names, so the only state this can act
 * on is an account that has never asked, where Details is absent entirely.
 */
export function sesProductionAccess(account: unknown): SesProductionAccess {
  const details = account as { ProductionAccessEnabled?: boolean; Details?: { ReviewDetails?: { Status?: string; CaseId?: string } } }
  if (details?.ProductionAccessEnabled === true) return { state: 'granted' }

  const review = details?.Details?.ReviewDetails
  const status = review?.Status?.toUpperCase()
  if (!status) return { state: 'request' }

  // A freshly opened review carries no CaseId — omit the key rather than carry it as
  // undefined, so `'caseId' in access` means what it says.
  const caseId = review?.CaseId ? { caseId: review.CaseId } : {}
  return status === 'PENDING' ? { state: 'pending', ...caseId } : { state: 'closed', status, ...caseId }
}
