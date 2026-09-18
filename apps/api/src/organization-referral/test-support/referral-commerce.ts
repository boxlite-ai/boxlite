import { fork, ChildProcess, execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream, existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DataSource } from 'typeorm'

/** Owns exactly one fresh Commerce database and one real Commerce process. */
export class ReferralCommerce {
  readonly name = 'commerce_referral_' + randomUUID().replace(/-/g, '')
  readonly token = randomUUID()
  readonly workspace = resolve(
    process.env.COMMERCE_WORKSPACE || join(__dirname, '../../../../../..', 'boxlite-commerce'),
  )
  database: DataSource
  url: string
  revision: string
  sourceSha256: string
  private admin: DataSource
  private child?: ChildProcess
  private exited?: Promise<void>
  private created = false

  async start(): Promise<void> {
    if (!existsSync(join(this.workspace, 'src/billing-events/api/billing-events.controller.ts')))
      throw new Error('Acceptance requires COMMERCE_WORKSPACE with the real billing-events implementation')
    this.revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: this.workspace, encoding: 'utf8' }).trim()
    const source = createHash('sha256')
    const files = readdirSync(join(this.workspace, 'src'), { recursive: true, withFileTypes: true })
      .filter((file) => file.isFile())
      .map((file) => join(file.parentPath, file.name))
      .sort()
    for (const file of [...files, join(this.workspace, 'package.json')])
      source.update(file.slice(this.workspace.length)).update(readFileSync(file))
    this.sourceSha256 = source.digest('hex')
    const options = {
      type: 'postgres' as const,
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      ssl: process.env.DB_TLS_ENABLED === 'true' ? { rejectUnauthorized: true } : false,
      extra: { connectionTimeoutMillis: 10000 },
    }
    this.admin = await new DataSource({ ...options, database: 'postgres' }).initialize()
    try {
      await this.admin.query('CREATE DATABASE "' + this.name + '"')
      this.created = true
      this.database = await new DataSource({ ...options, database: this.name }).initialize()
      const env = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
        COMMERCE_WORKSPACE: this.workspace,
        DB_HOST: process.env.DB_HOST,
        DB_PORT: process.env.DB_PORT,
        DB_USERNAME: process.env.DB_USERNAME,
        DB_PASSWORD: process.env.DB_PASSWORD,
        DB_DATABASE: this.name,
        DB_SSL: String(!!options.ssl),
        USAGE_INGEST_TOKEN: this.token,
        COMMERCE_API_TOKENS: randomUUID() + ':acceptance',
        COUPON_REWARD_RULES: JSON.stringify({ InvitationReward: { creditCents: 137, maxRewardsPerOrganization: 2 } }),
        SIGNUP_CREDIT_CENTS: '0',
      }
      const log = createWriteStream(join(process.env.REFERRAL_REPORT_DIR, 'commerce.log'))
      this.child = fork(join(__dirname, '../../../../referral-tests/commerce-server.cjs'), [], {
        cwd: this.workspace,
        env,
        execArgv: [],
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      })
      this.child.stdout.pipe(log, { end: false })
      this.child.stderr.pipe(log, { end: false })
      this.exited = new Promise((resolveExit) =>
        this.child.once('exit', () => {
          log.end()
          resolveExit()
        }),
      )
      await new Promise<void>((resolveReady, reject) => {
        const deadline = setTimeout(() => reject(new Error('Commerce readiness timed out after 120 seconds')), 120000)
        const fail = () => {
          clearTimeout(deadline)
          reject(new Error('Commerce exited before readiness'))
        }
        this.child.once('exit', fail)
        this.child.once('error', reject)
        this.child.on('message', (message: { type: string; url?: string; name?: string; code?: string }) => {
          if (message.type === 'ready') {
            clearTimeout(deadline)
            this.child.removeListener('exit', fail)
            this.url = message.url
            resolveReady()
          } else if (message.type === 'error') {
            clearTimeout(deadline)
            reject(new Error('Commerce boot failed: ' + message.name + ' ' + (message.code || '')))
          }
        })
      })
    } catch (error) {
      await this.close()
      throw error
    }
  }

  async ledger(organizationId: string) {
    const [counts] = await this.database.query(
      `SELECT
      (SELECT count(*)::int FROM commerce_billing_events WHERE organization_id = $1) AS events,
      (SELECT count(*)::int FROM commerce_coupons WHERE organization_id = $1) AS coupons,
      (SELECT count(*)::int FROM commerce_coupon_redemption_records WHERE organization_id = $1) AS redemptions,
      (SELECT count(*)::int FROM commerce_wallets WHERE organization_id = $1) AS wallets,
      count(*)::int AS movements, COALESCE(sum(amount_cents), 0)::int AS granted
      FROM commerce_wallet_transactions WHERE organization_id = $1`,
      [organizationId],
    )
    return counts
  }

  async rewardIds(organizationId: string) {
    return this.database.query(
      `SELECT id AS "redemptionId", coupon_id AS "couponId",
      wallet_transaction_id AS "walletTransactionId", credit_cents::int AS "creditCents"
      FROM commerce_coupon_redemption_records WHERE organization_id = $1 ORDER BY created_at`,
      [organizationId],
    )
  }

  async close(): Promise<void> {
    let forced = false
    if (this.child && this.child.exitCode === null) {
      if (this.child.connected) this.child.send('stop')
      const deadline = setTimeout(() => {
        forced = true
        this.child.kill('SIGKILL')
      }, 30000)
      try {
        await this.exited
      } finally {
        clearTimeout(deadline)
      }
    }
    if (this.database?.isInitialized) await this.database.destroy()
    if (this.created && this.admin?.isInitialized) {
      await this.admin.query('DROP DATABASE "' + this.name + '"')
      this.created = false
    }
    if (this.admin?.isInitialized) await this.admin.destroy()
    if (forced) throw new Error('Commerce exceeded the 30-second shutdown budget')
  }
}
