import 'reflect-metadata'
import { createServer } from 'node:http'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ReferralDatabase } from './referral-database'
import { startReferralApi, closeServer } from './referral-http'
import { UserRegistration } from '../../user/user-registration.entity'
import { Region } from '../../region/entities/region.entity'
import { RegionType } from '../../region/enums/region-type.enum'
import { startOidcProvider } from './browser-oidc'

async function main() {
  const fixture = new ReferralDatabase()
  let oidc: Awaited<ReturnType<typeof startOidcProvider>>
  let api: Awaited<ReturnType<typeof startReferralApi>>
  let gateway: ReturnType<typeof createServer>
  let stopping = false
  const stop = async (exitCode = 0) => {
    if (stopping) return
    stopping = true
    const deadline = setTimeout(() => {
      console.error('Browser fixture shutdown exceeded 45 seconds')
      process.exit(1)
    }, 45000)
    const step = async (name: string, action: () => Promise<unknown>) => {
      await writeFile(
        join(process.env.REFERRAL_REPORT_DIR, 'browser-cleanup-progress.json'),
        JSON.stringify({ step: name, at: new Date().toISOString(), database: fixture.name }),
      )
      await action()
    }
    try {
      if (gateway?.listening) await step('gateway', () => closeServer(gateway))
      await step('api', async () => api?.close())
      await step('oidc', async () => oidc?.close())
      await step('database', () => fixture.close())
      await writeFile(
        join(process.env.REFERRAL_REPORT_DIR, 'browser-cleanup.json'),
        JSON.stringify({ status: 'clean', database: fixture.name }),
      )
      clearTimeout(deadline)
      process.exit(exitCode)
    } catch (error) {
      console.error('Fixture cleanup failed:', error.name)
      process.exit(1)
    }
  }
  process.on('SIGTERM', () => void stop())
  process.on('SIGINT', () => void stop())
  try {
    const database = await fixture.initialize()
    oidc = await startOidcProvider()
    api = await startReferralApi(await fixture.connect('browser-api'), oidc.issuer, fixture.name)
    await database.getRepository(Region).save(
      new Region({
        id: 'referral-test',
        name: 'Browser region',
        regionType: RegionType.SHARED,
        enforceQuotas: false,
      }),
    )
    await api.users.create({ id: 'browser-inviter', name: 'Browser inviter', emailVerified: true })
    const inviter = await api.organizations.findDefaultForUser('browser-inviter')
    const { referralCode } = await api.referrals.getCode(inviter.id)
    let subject = 'browser-user'
    const observed: string[] = []
    gateway = createServer(async (request, response) => {
      try {
        const url = new URL(request.url, 'http://127.0.0.1:4491')
        response.setHeader('Content-Type', 'application/json')
        if (url.pathname === '/__test__/ready') {
          response.end(JSON.stringify({ ready: true, referralCode }))
          return
        }
        if (url.pathname === '/__test__/identity' && request.method === 'POST') {
          const chunks = []
          for await (const chunk of request) chunks.push(chunk)
          const input = JSON.parse(Buffer.concat(chunks).toString())
          subject = input.subject
          oidc.setIdentity({ subject, verified: input.verified !== false })
          observed.length = 0
          response.end('{}')
          return
        }
        if (url.pathname === '/__test__/result') {
          const registration = await database.getRepository(UserRegistration).findOneBy({ userId: subject })
          response.end(JSON.stringify({ registration, observed }))
          return
        }
        if (url.pathname === '/api/config') {
          response.end(
            JSON.stringify({
              version: 'referral-test',
              oidc: { issuer: oidc.issuer, clientId: 'referral-browser', audience: 'referral-test' },
              linkedAccountsEnabled: false,
              announcements: {},
              proxyTemplateUrl: '',
              proxyToolboxUrl: '',
              dashboardUrl: 'http://127.0.0.1:4390',
              maintananceMode: false,
              environment: 'test',
              billingApiUrl: '',
            }),
          )
          return
        }
        if (url.pathname.startsWith('/api/')) {
          observed.push(request.method + ' ' + url.pathname + url.search)
          const result = await fetch(api.url + url.pathname + url.search, {
            headers: request.headers.authorization ? { Authorization: request.headers.authorization } : {},
            signal: AbortSignal.timeout(15000),
          })
          response.statusCode = result.status
          response.end(await result.text())
          return
        }
        response.statusCode = 404
        response.end('{}')
      } catch {
        response.statusCode = 500
        response.end(JSON.stringify({ message: 'Test gateway failed' }))
      }
    })
    await new Promise<void>((resolve) => gateway.listen(4491, '127.0.0.1', resolve))
    await writeFile(
      join(process.env.REFERRAL_REPORT_DIR, 'browser-environment.json'),
      JSON.stringify(
        {
          database: fixture.name,
          issuer: oidc.issuer,
          inviterOrganizationId: inviter.id,
        },
        null,
        2,
      ),
    )
  } catch (error) {
    console.error('Browser fixture failed:', error.name, error.code ?? '')
    await stop(1)
  }
}
void main()
