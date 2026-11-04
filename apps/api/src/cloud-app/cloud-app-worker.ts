import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common'
import { TypedConfigService } from '../config/typed-config.service'
import { RedisLockProvider, withRedisLockLease } from '../box/common/redis-lock.provider'
import { CloudAppService } from './cloud-app.service'
import { purgeExpired } from './engine/lifecycle'

@Injectable()
export class CloudAppWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(CloudAppWorker.name)
  private timer?: NodeJS.Timeout
  private readonly stopping = new AbortController()
  private readonly running = new Map<string, Promise<void>>()
  private maintenanceAt = 0

  constructor(
    private readonly apps: CloudAppService,
    private readonly config: TypedConfigService,
    private readonly locks: RedisLockProvider,
  ) {}

  onApplicationBootstrap() {
    if (
      this.config.get('skipConnections') ||
      !this.config.get('cloudApps.publicUrl') ||
      this.config.get('cloudApps.processRole') !== 'worker'
    )
      return
    this.timer = setInterval(() => void this.tick().catch(() => this.logger.error('App worker polling failed')), 2000)
    this.timer.unref()
  }

  async onApplicationShutdown() {
    clearInterval(this.timer)
    this.stopping.abort(new Error('App worker shutting down'))
    await Promise.allSettled(this.running.values())
  }

  async tick(): Promise<void> {
    if (this.stopping.signal.aborted) return
    const jobs: { env_id: string; org_id: string }[] = await this.apps.database.query(
      `SELECT DISTINCT d.env_id, a.org_id FROM cloud_app.deployments d JOIN cloud_app.envs e ON e.id = d.env_id JOIN cloud_app.apps a ON a.id = e.app_id
       WHERE d.status IN ('queued', 'uploading', 'building', 'migrating', 'starting') AND a.deleted_at IS NULL`,
    )
    for (const job of jobs) {
      if (this.running.has(job.env_id)) continue
      const work = this.run(job)
        .catch(() => this.logger.error(`App deployment worker failed for ${job.env_id}`))
        .finally(() => this.running.delete(job.env_id))
      this.running.set(job.env_id, work)
    }
    if (Date.now() - this.maintenanceAt >= 30_000 && !this.running.has('maintenance')) {
      this.maintenanceAt = Date.now()
      const work = this.maintain()
        .catch(() => this.logger.error('App maintenance failed'))
        .finally(() => this.running.delete('maintenance'))
      this.running.set('maintenance', work)
    }
  }

  private async run(job: { env_id: string; org_id: string }): Promise<void> {
    const lease = await this.locks.acquireLease(`cloud-app:deploy:${job.env_id}`, 60)
    if (!lease) return
    await withRedisLockLease(lease, async (signal) => {
      const ctx = this.apps.context(job.org_id)
      signal.throwIfAborted()
      await ctx.orchestrator.recover(job.env_id)
      await ctx.orchestrator.runQueued(job.env_id, AbortSignal.any([signal, this.stopping.signal]))
    })
  }

  private async maintain(): Promise<void> {
    const lease = await this.locks.acquireLease('cloud-app:maintenance', 60)
    if (!lease) return
    await withRedisLockLease(lease, async (signal) => {
      const organizations: { org_id: string }[] = await this.apps.database.query(
        'SELECT DISTINCT org_id FROM cloud_app.apps',
      )
      for (const { org_id } of organizations) {
        signal.throwIfAborted()
        this.stopping.signal.throwIfAborted()
        const ctx = this.apps.context(org_id)
        await ctx.scheduler.tick()
        await purgeExpired(ctx)
      }
    })
  }
}
