// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReferralCodeSection } from './ReferralCodeSection'

const fixture = vi.hoisted(() => ({
  organization: { id: 'org-1', name: 'First organization' },
  api: { getOrganizationReferralCode: vi.fn() },
  clipboard: vi.fn(),
}))
vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({ selectedOrganization: fixture.organization }),
}))
vi.mock('@/hooks/useApi', () => ({ useApi: () => ({ organizationsApi: fixture.api }) }))
describe('F01–F04 organization invitation sharing', () => {
  let root: Root, host: HTMLDivElement
  const flush = async () => {
    await act(async () => {
      await Promise.resolve()
    })
  }
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    fixture.organization = { id: 'org-1', name: 'First organization' }
    fixture.api.getOrganizationReferralCode.mockReset()
    fixture.clipboard.mockReset()
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: fixture.clipboard } })
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    host.remove()
  })
  async function render() {
    await act(async () => root.render(<ReferralCodeSection />))
    await flush()
  }
  it('loads a code independently and reports success only after clipboard resolution', async () => {
    fixture.api.getOrganizationReferralCode.mockResolvedValue({
      data: { organizationId: 'org-1', referralCode: 'ABCD2345EF' },
    })
    await render()
    let resolve: () => void
    fixture.clipboard.mockImplementation(
      () =>
        new Promise<void>((r) => {
          resolve = r
        }),
    )
    const button = host.querySelector('[aria-label="Copy invitation link"]') as HTMLButtonElement
    await act(async () => button.click())
    expect(host.textContent).not.toContain('Copied')
    expect(fixture.clipboard).toHaveBeenCalledWith(window.location.origin + '/register?referredCode=ABCD2345EF')
    await act(async () => resolve())
    expect(host.textContent).toContain('Copied')
  })
  it('retains selectable text after clipboard denial', async () => {
    fixture.api.getOrganizationReferralCode.mockResolvedValue({
      data: { organizationId: 'org-1', referralCode: 'ABCD2345EF' },
    })
    fixture.clipboard.mockRejectedValue(new Error('Denied'))
    await render()
    await act(async () => (host.querySelector('[aria-label="Copy code"]') as HTMLButtonElement).click())
    expect((host.querySelector('textarea') as HTMLTextAreaElement).value).toBe('ABCD2345EF')
    expect(host.textContent).not.toContain('Copied')
  })
  it('clears old values immediately and ignores late organization responses', async () => {
    let old: (value: unknown) => void
    fixture.api.getOrganizationReferralCode
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            old = r
          }),
      )
      .mockResolvedValueOnce({ data: { organizationId: 'org-2', referralCode: 'ABCDEFGH23' } })
    await render()
    fixture.organization = { id: 'org-2', name: 'Second organization' }
    await render()
    await act(async () => old({ data: { organizationId: 'org-1', referralCode: 'ABCD2345EF' } }))
    expect(host.textContent).toContain('Second organization')
    expect(host.textContent).toContain('ABCDEFGH23')
    expect(host.textContent).not.toContain('ABCD2345EF')
  })
})
