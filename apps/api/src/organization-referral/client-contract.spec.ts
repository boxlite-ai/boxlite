import { OrganizationsApiAxiosParamCreator } from '@boxlite-ai/api-client'

describe('Organization referral query client', () => {
  const client = OrganizationsApiAxiosParamCreator()
  it('preserves the existing list request options', async () => {
    const request = await client.listOrganizations({ timeout: 1234 })
    expect(request.url).toBe('/organizations')
    expect(request.options.timeout).toBe(1234)
  })
  it('generates the organization referral code path', async () => {
    expect((await client.getOrganizationReferralCode('organization-id')).url).toBe(
      '/organizations/organization-id/referral-code',
    )
  })
})
