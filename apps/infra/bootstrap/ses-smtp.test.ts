// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import test from 'node:test'

import { sesProductionAccess, sesSmtpPasswordV4 } from './ses-smtp.js'

/*
 * Vectors from terraform-provider-aws' own suite for the same conversion
 * (internal/service/iam/access_key_test.go, TestSESSMTPPasswordFromSecretKeySigV4).
 * A second implementation of a published algorithm is only worth anything if it
 * agrees with one that is already known to authenticate against SES — deriving
 * the expectations here from this code would prove nothing but that it is stable.
 */
const VECTORS = [
  { region: 'eu-central-1', secret: 'some+secret+key', expected: 'BMXhUYlu5Z3gSXVQORxlVa7XPaz91aGWdfHxvkOZdWZ2' },
  { region: 'eu-central-1', secret: 'another+secret+key', expected: 'BBbphbrQmrKMx42d1N6+C7VINYEBGI5v9VsZeTxwskfh' },
  { region: 'us-west-1', secret: 'some+secret+key', expected: 'BH+jbMzper5WwlwUar9E1ySBqHa9whi0GPo+sJ0mVYJj' },
  { region: 'us-west-1', secret: 'another+secret+key', expected: 'BKVmjjMDFk/qqw8EROW99bjCS65PF8WKvK5bSr4Y6EqF' },
]

test('derives the SMTP password AWS expects for a secret access key', () => {
  for (const { region, secret, expected } of VECTORS) {
    assert.equal(sesSmtpPasswordV4(secret, region), expected, `${secret} in ${region}`)
  }
})

test('binds the password to one region', () => {
  // The stack sends through one regional endpoint; a password derived for another
  // authenticates nowhere, so this must not silently be region-agnostic.
  assert.notEqual(
    sesSmtpPasswordV4('some+secret+key', 'ap-southeast-1'),
    sesSmtpPasswordV4('some+secret+key', 'us-west-1'),
  )
})

test('refuses to derive from a missing credential', () => {
  // An empty secret would still hash to a well-formed password, and the failure
  // would surface as an SES auth rejection long after the credential was stored.
  assert.throws(() => sesSmtpPasswordV4('', 'ap-southeast-1'), /secret access key/)
  assert.throws(() => sesSmtpPasswordV4('some+secret+key', ''), /region/)
})

test('asks for production access only when there is something to ask for', () => {
  // The live shape of an account that has never requested it: no Details key at all,
  // which is what a `Details.ReviewDetails.Status` read would trip over.
  assert.deepEqual(
    sesProductionAccess({
      DedicatedIpAutoWarmupEnabled: true,
      EnforcementStatus: 'HEALTHY',
      ProductionAccessEnabled: false,
      SendQuota: { Max24HourSend: 200, MaxSendRate: 1, SentLast24Hours: 0 },
      SendingEnabled: true,
    }),
    { state: 'request' },
  )

  // Already sending — asking again edits account details that are not in review.
  assert.deepEqual(sesProductionAccess({ ProductionAccessEnabled: true }), { state: 'granted' })

  // A review is open. Submitting a second one is refused, and the details are frozen
  // until it closes, so bootstrap has to leave this alone rather than retry.
  assert.deepEqual(
    sesProductionAccess({
      ProductionAccessEnabled: false,
      Details: { ReviewDetails: { Status: 'PENDING', CaseId: '1234567890' } },
    }),
    { state: 'pending', caseId: '1234567890' },
  )

  // The live shape of a review AWS has just opened: PENDING with no CaseId at all.
  // Recorded from a real submission, because a fixture written from the API reference
  // carries a case id and this one does not.
  assert.deepEqual(
    sesProductionAccess({
      ProductionAccessEnabled: false,
      Details: {
        MailType: 'TRANSACTIONAL',
        WebsiteURL: 'https://boxlite.ai',
        ContactLanguage: 'EN',
        UseCaseDescription: 'Transactional only. …',
        ReviewDetails: { Status: 'PENDING' },
      },
    }),
    { state: 'pending' },
  )

  // A closed review is NOT askable again: AWS answered ConflictException to exactly this
  // payload shape, so the caller has to report the case rather than spend a second
  // submission. Shaped from a real denial; the case id is synthetic, since an
  // account-linked support case number proves nothing a placeholder does not.
  assert.deepEqual(
    sesProductionAccess({
      ProductionAccessEnabled: false,
      Details: {
        MailType: 'TRANSACTIONAL',
        WebsiteURL: 'https://boxlite.ai',
        ContactLanguage: 'EN',
        UseCaseDescription: 'Transactional only. …',
        ReviewDetails: { Status: 'DENIED', CaseId: '000000000000000' },
      },
    }),
    { state: 'closed', status: 'DENIED', caseId: '000000000000000' },
  )
  assert.deepEqual(
    sesProductionAccess({ ProductionAccessEnabled: false, Details: { ReviewDetails: { Status: 'FAILED' } } }),
    { state: 'closed', status: 'FAILED' },
  )
})

test('reads production access from the account flag, not from the review record', () => {
  // The flag is what decides whether a send is accepted; a stale or inconsistent
  // review record must not be able to report an account as ready when it is not.
  assert.deepEqual(
    sesProductionAccess({ ProductionAccessEnabled: false, Details: { ReviewDetails: { Status: 'GRANTED' } } }),
    { state: 'closed', status: 'GRANTED' },
  )
  assert.deepEqual(sesProductionAccess({}), { state: 'request' })
  assert.deepEqual(sesProductionAccess(undefined), { state: 'request' })
})
