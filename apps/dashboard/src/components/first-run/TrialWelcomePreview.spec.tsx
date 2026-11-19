// @vitest-environment jsdom
/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import TrialWelcomePreview from './TrialWelcomePreview'
vi.mock('./WelcomeBoxIllustration', () => ({ default: () => null }))
let root: ReturnType<typeof createRoot>
let host: HTMLDivElement
function Location() {
  return <output>{useLocation().pathname}</output>
}
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  render()
})
function render(initialScenario = 'eligible', onContinue?: () => void) {
  act(() =>
    root.render(
      <MemoryRouter key={initialScenario}>
        <TrialWelcomePreview organizationName="Acme" initialScenario={initialScenario} onContinue={onContinue} />
        <Location />
      </MemoryRouter>,
    ),
  )
}
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})
function click(text: string) {
  const button = [...host.querySelectorAll('button')].find((item) => item.textContent?.trim() === text)
  expect(button, text).toBeTruthy()
  act(() => button!.click())
}
it('keeps Team through verification and requires explicit activation before Quickstart', () => {
  act(() => (host.querySelector('input[value="Team"]') as HTMLInputElement).click())
  click('Continue to free trial')
  click('Verify card')
  expect(host.textContent).toContain('Your trial, at a glance')
  expect(host.textContent).toContain('$100 / month')
  expect(host.textContent).toContain('Subscription fee today$0')
  expect(host.textContent).not.toContain('Team is active')
  click('Start 3-day trial')
  expect(host.querySelector('output')?.textContent).toBe('/dashboard/quickstart')
})
it('does not activate or verify when card setup is cancelled', () => {
  click('Continue to free trial')
  click('Back to plans')
  click('Continue to free trial')
  expect(host.textContent).toContain('Not connected')
  expect(host.textContent).not.toContain('Start 3-day trial')
})
it('discloses payment for an ineligible account and never offers a trial button', () => {
  render('ineligible')
  click('Continue with Starter')
  click('Verify card')
  expect(host.textContent).toContain('Subscription fee today$5')
  expect(host.textContent).not.toContain('Start 3-day trial')
  click('Subscribe for $5/month')
  expect(host.querySelector('output')?.textContent).toBe('/dashboard/quickstart')
})
it('blocks unknown eligibility; retry preserves the selected plan', () => {
  render('unavailable')
  act(() => (host.querySelector('input[value="Team"]') as HTMLInputElement).click())
  expect(host.querySelector('[role="alert"]')).toBeTruthy()
  expect(host.textContent).not.toContain('Continue to free trial')
  click('Try again')
  expect(host.textContent).toContain('Continue to free trial')
})
it('changing plan after verification keeps the card but updates confirmation', () => {
  click('Continue to free trial')
  click('Verify card')
  click('Change plan')
  act(() => (host.querySelector('input[value="Team"]') as HTMLInputElement).click())
  click('Continue to confirmation')
  expect(host.textContent).toContain('$100 / month')
  expect(host.textContent).toContain('Card verified')
})

it('shows no local-preview tooling or simulation labels in the product UI', () => {
  expect(host.textContent).not.toMatch(/local|preview|simulation|simulated|mock/i)
  click('Continue to free trial')
  expect(host.textContent).not.toMatch(/local|preview|simulation|simulated|mock/i)
})

it('offers no-card continuation independently of eligibility', () => {
  render('unavailable')
  click('Explore console — no card required')
  expect(host.querySelector('output')?.textContent).toBe('/dashboard/quickstart')
  expect(host.textContent).not.toContain('Card verified')
})
it('allows a coupon without selecting or verifying a paid subscription', () => {
  click('Have a coupon? Redeem code')
  click('Redeem')
  expect(host.textContent).toContain('Enter a coupon code.')
  const input = host.querySelector('#trial-coupon') as HTMLInputElement
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'ACME50')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  click('Redeem')
  expect(host.textContent).not.toContain('Card verified')
  expect(host.querySelector('output')?.textContent).toBe('/dashboard/quickstart')
})

it('uses the provided Welcome completion when skipping', () => {
  const complete = vi.fn()
  render('eligible', complete)
  click('Explore console — no card required')
  expect(complete).toHaveBeenCalledOnce()
})
