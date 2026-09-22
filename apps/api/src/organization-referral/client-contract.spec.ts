import { OrganizationsApiAxiosParamCreator } from '@boxlite-ai/api-client'

describe('A01–A03 generated organization client', () => {
  const client = OrganizationsApiAxiosParamCreator()
  it('preserves ordinary list requests and serializes the new code query', async () => {
    expect((await client.listOrganizations()).url).toBe('/organizations')
    expect((await client.listOrganizations({ referredCode: 'ABCD2345EF' })).url).toBe(
      '/organizations?referredCode=ABCD2345EF',
    )
  })
  it('preserves options-only calls without serializing request options into the query', async () => {
    const options = { headers: { Authorization: 'Bearer test-token' }, timeout: 1234 }
    const request = await client.listOrganizations(options)
    expect(request.url).toBe('/organizations')
    expect(request.options.timeout).toBe(1234)
    expect(request.options.headers).toMatchObject(options.headers)
  })
  it('generates the organization referral code path', async () => {
    expect((await client.getOrganizationReferralCode('organization-id')).url).toBe(
      '/organizations/organization-id/referral-code',
    )
  })
})
