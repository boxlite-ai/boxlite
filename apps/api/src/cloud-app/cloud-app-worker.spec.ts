import { CloudAppWorker } from './cloud-app-worker'
import { CloudAppService } from './cloud-app.service'
import { TypedConfigService } from '../config/typed-config.service'
import { RedisLockProvider } from '../box/common/redis-lock.provider'

describe('App publication worker', () => {
  const setup = (role = 'worker') => {
    const signal = new AbortController().signal
    const release = jest.fn().mockResolvedValue(undefined)
    const locks = { acquireLease: jest.fn().mockResolvedValue({ signal, release }) }
    const recover = jest.fn().mockResolvedValue(undefined)
    const runQueued = jest.fn().mockResolvedValue(undefined)
    const apps = {
      database: { query: jest.fn().mockResolvedValue([{ env_id: 'env_main', org_id: 'org' }]) },
      context: jest.fn().mockReturnValue({ orchestrator: { recover, runQueued } }),
    }
    const settings = { 'cloudApps.processRole': role, 'cloudApps.publicUrl': 'https://api.example/api/internal/apps' }
    const worker = new CloudAppWorker(
      apps as unknown as CloudAppService,
      { get: (name) => settings[name] } as unknown as TypedConfigService,
      locks as unknown as RedisLockProvider,
    )
    // Keep this test on publication; maintenance has a separate lease.
    Object.assign(worker, { maintenanceAt: Date.now() })
    return { worker, apps, locks, recover, runQueued, release }
  }

  it('never starts a poller in API replicas', () => {
    jest.useFakeTimers()
    const { worker, apps } = setup('api')
    worker.onApplicationBootstrap()
    jest.advanceTimersByTime(10_000)
    expect(apps.database.query).not.toHaveBeenCalled()
    jest.useRealTimers()
  })

  it('recovers and executes persisted work under an environment lease', async () => {
    const { worker, locks, recover, runQueued, release } = setup()
    await worker.tick()
    await worker.onApplicationShutdown()
    expect(locks.acquireLease).toHaveBeenCalledWith('cloud-app:deploy:env_main', 60)
    expect(recover).toHaveBeenCalledWith('env_main')
    expect(runQueued).toHaveBeenCalledWith('env_main', expect.any(AbortSignal))
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('leaves a deployment alone while another worker owns its lease', async () => {
    const { worker, locks, recover, runQueued } = setup()
    locks.acquireLease.mockResolvedValue(null)
    await worker.tick()
    await worker.onApplicationShutdown()
    expect(recover).not.toHaveBeenCalled()
    expect(runQueued).not.toHaveBeenCalled()
  })
})
