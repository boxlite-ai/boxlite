import { OrganizationsApiAxiosParamCreator } from '@boxlite-ai/api-client'

describe('A01–A03 generated organization client', () => {
  const client = OrganizationsApiAxiosParamCreator()
  it('preserves ordinary list requests and serializes the new code query', async () => {
    expect((await client.listOrganizations()).url).toBe('/organizations')
    expect((await client.listOrganizations('ABCD2345EF')).url).toBe('/organizations?referredCode=ABCD2345EF')
  })
  it('keeps options in the second slot, outside the query', async () => {
    const request = await client.listOrganizations(undefined, { headers: { 'X-Test': 'options' }, timeout: 1234 })
    expect(request.url).toBe('/organizations')
    expect(request.options.timeout).toBe(1234)
    expect(request.options.headers).toMatchObject({ 'X-Test': 'options' })
  })
  it('generates the organization referral code path', async () => {
    expect((await client.getOrganizationReferralCode('organization-id')).url).toBe(
      '/organizations/organization-id/referral-code',
    )
  })
})
