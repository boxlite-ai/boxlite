/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { Injectable, OnModuleInit, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common'
import { DEFAULT_RUNNER_LABELS, Listener, VerifiedWebhook } from '@boxlite-ai/ci-listener'
import { TypedConfigService } from '../config/typed-config.service'
import { CiNativeState } from './ci-native-state'
import { CiNativeHost } from './ci-native-host'
import { CiGitHubService } from './ci-github.service'
import { CiSettingsService } from './ci-settings.service'

/** Every API replica may receive; the PostgreSQL lease selects one scheduler. */
@Injectable()
export class CiListenerService implements OnModuleInit, OnModuleDestroy {
  private controller?: Listener
  private stop?: AbortController
  private task?: Promise<void>
  private starting?: Promise<void>
  private failure?: unknown
  constructor(
    private readonly store: CiNativeState,
    private readonly host: CiNativeHost,
    private readonly config: TypedConfigService,
    private readonly github: CiGitHubService,
    private readonly settings: CiSettingsService,
  ) {}
  async onModuleInit(): Promise<void> {
    if (!this.store.app) return
    for (const app of this.github.configured()) app.settings()
    await this.store.initialize()
    await this.settings.initialize()
    this.stop = new AbortController()
    this.controller = new Listener({
      state: this.store.state,
      host: this.host,
      worker: {
        image: this.config.get('ci.workerImage'),
        cpus: this.config.get('ci.workerCPUs'),
        memoryMiB: this.config.get('ci.workerMemoryGB') * 1024,
        labels: DEFAULT_RUNNER_LABELS,
      },
      capacity: this.settings,
    })
  }
  /** Called by the serving host after HTTP starts listening, never during module initialization. */
  start(): Promise<void> {
    return (this.starting ??= (async () => {
      if (!this.controller || this.stop!.signal.aborted) return
      if (!(await this.store.state.activate()) || this.stop!.signal.aborted) return
      this.task = this.controller.run(this.stop!.signal).catch((error) => {
        this.failure = error
        this.host.report(error, 'hosted-listener-stopped')
      })
    })())
  }
  async receive(notification: VerifiedWebhook, application: string = this.store.app): Promise<'stored' | 'duplicate'> {
    if (!this.controller) throw new ServiceUnavailableException('Hosted CI Listener is not configured')
    if (this.failure) throw new ServiceUnavailableException('Hosted CI Listener has stopped')
    const verified = { ...notification, application }
    return this.controller.receive(verified)
  }
  async onModuleDestroy(): Promise<void> {
    this.stop?.abort()
    try {
      await this.starting
      await this.task
    } finally {
      await this.host.close()
    }
    if (this.failure) throw this.failure
  }
}
