import { Injectable } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { DataSource, EntityManager } from 'typeorm'
import { Box } from '../entities/box.entity'
import { BootstrapIntent } from '../entities/outbound-control-record'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { BoxState } from '../enums/box-state.enum'
import { ProxyRegistryStore, ProxyReservation } from '../outbound-proxy/proxy-registry.store'
import { RunnerAdapter } from '../runner-adapter/runnerAdapter'
import { ProtectedBootControl, ProtectedBootReceipt } from '../runner-adapter/protected-runner'
import {
  hasProtectedBoxAuthority,
  LockedOutboundBox,
  OutboundPolicyStore,
  outboundRecord,
  persistedOutbound,
} from '../stores/outbound-policy.store'
import { settleTerminatedOutbound } from './managed-outbound-reconciliation'

type StartResult = 'ordinary' | 'pending' | 'ready' | 'managed-stopped'
type Placeholder = { image: string; metadata: Record<string, string>; nested: boolean }
type Retirement = 'stop' | 'destroy' | 'previous'

@Injectable()
export class ManagedOutboundBootstrap {
  private readonly store: OutboundPolicyStore

  constructor(
    source: DataSource,
    private readonly registry: ProxyRegistryStore,
  ) {
    this.store = new OutboundPolicyStore(source)
  }

  async resolveName(org: string, name: string) {
    await this.registry.get(org, name)
  }

  async isProtected(box: Box): Promise<boolean> {
    return this.store.locked(box.id, box.organizationId, ({ box: current, manager }) =>
      hasProtectedBoxAuthority(manager, current),
    )
  }

  async seed(manager: EntityManager, box: Box, proxyName: string | null) {
    const record = outboundRecord(box)
    const bootstrap = await this.makeIntent(manager, box, proxyName)
    const control = { ...record, bootstrap }
    await manager.update(Box, box.id, { outboundControl: control })
    box.outboundControl = control
  }

  async blocksExternalStart(box: Box): Promise<boolean> {
    const current = await this.store.read(box.id, box.organizationId)
    const record = outboundRecord(current)
    return !!(record.bootstrap || (record.managed && (record.managed.retirement || current.prevRunnerId)))
  }

  async legacyRestartIntent(box: Box) {
    const current = await this.store.read(box.id, box.organizationId)
    const record = outboundRecord(current)
    if (
      record.bootstrap ||
      record.managed ||
      record.pending ||
      current.prevRunnerId ||
      current.runnerId !== box.runnerId ||
      current.state !== BoxState.STOPPED ||
      current.pending
    )
      return undefined
    return {
      ...record,
      bootstrap: {
        proxyName: null,
        generation: randomUUID(),
        restart: true,
        key: {
          runner_id: current.runnerId,
          attempt_id: randomUUID(),
          registration_id: null,
          registration_revision: null,
          policy: persistedOutbound(current),
        },
      },
    }
  }

  private async makeIntent(
    manager: EntityManager,
    box: Box,
    proxyName: string | null,
    recovery?: BootstrapIntent['recovery'],
  ): Promise<BootstrapIntent> {
    const attemptId = randomUUID()
    const owner = { organizationId: box.organizationId, boxId: box.id, runnerId: box.runnerId, attemptId }
    const pin = recovery?.binding
      ? await this.registry.reserveRecoveryInTransaction(manager, owner, {
          runnerId: recovery.runnerId,
          binding: recovery.binding,
        })
      : proxyName === null
        ? null
        : await this.registry.reserveBootstrapInTransaction(manager, owner, proxyName)
    return {
      proxyName,
      generation: randomUUID(),
      recovery,
      key: {
        runner_id: box.runnerId,
        attempt_id: attemptId,
        registration_id: pin?.registrationId ?? null,
        registration_revision: pin ? String(pin.revision) : null,
        policy: persistedOutbound(box),
      },
    }
  }

  /** A retry with an existing claim may read or retire it, but cannot deliver material again. */
  async start(box: Box, adapter: RunnerAdapter, placeholder?: Placeholder): Promise<StartResult> {
    let current = await this.store.read(box.id, box.organizationId)
    let record = outboundRecord(current)
    if (!record.bootstrap && record.managed?.retirement?.resolved) {
      current = await this.beginRestart(current).catch(() => current)
      record = outboundRecord(current)
    }
    if (!record.bootstrap) {
      const { managed } = record
      if (!managed) return 'ordinary'
      const assigned = current.runnerId === managed.runnerId && !current.prevRunnerId
      if (current.state !== BoxState.STOPPED) return assigned ? 'ready' : 'pending'

      // Gate release and the lifecycle write commit separately. A worker can resume between them.
      const control = adapter.protectedBootstrap
      if (
        !assigned ||
        !current.pending ||
        current.desiredState !== BoxDesiredState.STARTED ||
        !managed.launch ||
        managed.retirement ||
        !control
      )
        return 'managed-stopped'
      const receipt = await control
        .readProtectedBoot(current.id, managed.launch.key, managed.epoch)
        .catch(() => undefined)
      return receipt?.outcome === 'confirmed' && receipt.epoch === managed.epoch ? 'ready' : 'managed-stopped'
    }
    const control = adapter.protectedBootstrap
    if (!control || !this.ownsStart(current, record.bootstrap)) return 'pending'

    try {
      const volumeRestart = !record.bootstrap.claim && !!record.bootstrap.restart && !!current.volumes?.length
      if (!(await control.supportsProtectedBootstrap(true, volumeRestart))) return 'pending'
      if (record.bootstrap.epoch) return await this.release(current, control)
      if (record.bootstrap.claim) return await this.recover(current, control)
      if (!record.bootstrap.restart) {
        if (!placeholder) return 'pending'
        await control.prepareProtectedBox(current, placeholder.image, placeholder.metadata, placeholder.nested)
      }
      const claim = randomUUID()
      const reserved = await this.store.locked(current.id, current.organizationId, async (locked) => {
        const currentRecord = outboundRecord(locked.box)
        const intent = currentRecord.bootstrap
        if (
          !intent ||
          intent.claim ||
          intent.epoch ||
          !this.ownsStart(locked.box, intent) ||
          intent.key.attempt_id !== record.bootstrap.key.attempt_id
        )
          return false
        await locked.write({ ...currentRecord, bootstrap: { ...intent, claim } })
        return true
      })
      if (!reserved) return 'pending'
      await this.store.locked(current.id, current.organizationId, async (locked) => {
        const intent = outboundRecord(locked.box).bootstrap
        if (!intent || intent.claim !== claim || intent.epoch || !this.ownsStart(locked.box, intent)) return
        const restartVolumes =
          intent.restart && locked.box.volumes?.length
            ? locked.box.volumes.map(({ volumeId, mountPath, subpath }) => ({ volumeId, mountPath, subpath }))
            : undefined
        if (!(await control.supportsProtectedBootstrap(true, restartVolumes !== undefined))) return
        const pin = this.pin(locked.box, intent)
        const route = pin ? await this.registry.loadBootstrapRoute(locked.manager, pin, this.recoveryPin(intent)) : null
        const receipt = await control.startProtectedBox(
          current.id,
          intent.key,
          route,
          intent.generation,
          intent.restart,
          restartVolumes,
        )
        await this.confirm(locked, intent, receipt)
      })
      return await this.release(current, control)
    } catch {
      // The persisted claim and pin remain the authority after a lost reply.
      return 'pending'
    }
  }

  private async recover(box: Box, control: ProtectedBootControl): Promise<StartResult> {
    await this.store.locked(box.id, box.organizationId, async (locked) => {
      const record = outboundRecord(locked.box)
      const intent = record.bootstrap
      if (!intent?.claim || intent.epoch || !this.ownsStart(locked.box, intent)) return
      const receipt = await control.readProtectedBoot(box.id, intent.key).catch(() => undefined)
      if (receipt?.outcome === 'confirmed') {
        await this.confirm(locked, intent, receipt)
        return
      }
      const retired = receipt ?? (await control.retireProtectedBoot(box.id, intent.key).catch(() => undefined))
      if (retired?.outcome !== 'retired') return
      const pin = this.pin(locked.box, intent)
      if (pin) await this.registry.retireBootstrapInTransaction(locked.manager, pin)
      const next = await this.makeIntent(locked.manager, locked.box, intent.proxyName, intent.recovery)
      await locked.write({ ...record, bootstrap: { ...next, restart: intent.restart } })
    })
    return this.release(box, control)
  }

  private async confirm(locked: LockedOutboundBox, intent: BootstrapIntent, receipt: ProtectedBootReceipt) {
    if (receipt.outcome !== 'confirmed' || !receipt.epoch || receipt.epoch === intent.recovery?.epoch) return
    const pin = this.pin(locked.box, intent)
    if (pin)
      await this.registry.promoteBootstrapInTransaction(locked.manager, pin, receipt.epoch, this.recoveryPin(intent))
    const { key, generation } = intent
    await locked.write(
      {
        ...outboundRecord(locked.box),
        revision: key.policy.revision,
        bootstrap: { ...intent, epoch: receipt.epoch },
        managed: {
          runnerId: key.runner_id,
          epoch: receipt.epoch,
          binding: pin
            ? {
                epoch: receipt.epoch,
                registration_id: pin.registrationId,
                registration_revision: String(pin.revision),
              }
            : null,
          launch: { key, generation },
        },
      },
      key.policy,
    )
  }

  private async release(box: Box, control: ProtectedBootControl): Promise<StartResult> {
    return this.store.locked(box.id, box.organizationId, async (locked) => {
      const record = outboundRecord(locked.box)
      const { bootstrap, managed } = record
      if (
        !bootstrap ||
        !bootstrap.epoch ||
        !managed ||
        bootstrap.epoch !== managed.epoch ||
        !this.ownsStart(locked.box, bootstrap)
      )
        return 'pending'
      if (bootstrap.recovery && bootstrap.recovery.epoch === bootstrap.epoch) return 'pending'
      await control.changeProtectedBootGate(box.id, bootstrap.key, bootstrap.epoch, bootstrap.generation, 'release', {
        snapshot: persistedOutbound(locked.box),
        binding: managed.binding,
      })
      await locked.write({ ...record, bootstrap: undefined })
      return 'ready'
    })
  }

  async retire(box: Box, adapter: RunnerAdapter, purpose: Retirement, force = false): Promise<boolean> {
    const control = adapter.protectedBootstrap
    if (!control) return false
    try {
      if (purpose === 'destroy') await this.abandonUnconfirmed(box, control)
      const sealed = await this.store.locked(box.id, box.organizationId, async (locked) => {
        const record = outboundRecord(locked.box)
        const managed = record.managed
        if (!managed?.launch || !this.ownsRetirement(locked.box, managed.runnerId, purpose)) return false
        if (managed.retirement) return true
        const { key, generation } = managed.launch
        const evidence = await control.sealProtectedEpoch(box.id, key, managed.epoch, generation)
        await locked.write({ ...record, managed: { ...managed, retirement: { evidence, terminated: false } } })
        return true
      })
      if (!sealed) return false
      const reconciled = await this.store.locked(box.id, box.organizationId, async (locked) => {
        const record = outboundRecord(locked.box)
        const managed = record.managed
        const retirement = managed?.retirement
        if (!retirement || !managed.launch || !this.ownsRetirement(locked.box, managed.runnerId, purpose)) return false
        if (!retirement.terminated) {
          const { key } = managed.launch
          let receipt = await control.retireProtectedBoot(box.id, key, managed.epoch).catch(() => undefined)
          if (!receipt) {
            await adapter.stopBox(box.id, force).catch(() => undefined)
            receipt = await control.retireProtectedBoot(box.id, key, managed.epoch).catch(() => undefined)
          }
          if (receipt?.outcome !== 'retired' || receipt.epoch !== managed.epoch) return false
          await locked.write({
            ...record,
            bootstrap: undefined,
            managed: { ...managed, retirement: { ...retirement, terminated: true } },
          })
        }
        if (!retirement.resolved) {
          if (!(await settleTerminatedOutbound(locked))) return false
          const current = outboundRecord(locked.box)
          await locked.write({
            ...current,
            managed: { ...current.managed, retirement: { ...current.managed.retirement, resolved: true } },
          })
        }
        return true
      })
      if (!reconciled || purpose === 'stop') return reconciled
      return await this.store.locked(box.id, box.organizationId, async (locked) => {
        const record = outboundRecord(locked.box)
        const managed = record.managed
        if (
          !managed?.launch ||
          !managed.retirement?.resolved ||
          !this.ownsRetirement(locked.box, managed.runnerId, purpose)
        )
          return false
        await control.removeRetiredEpoch(box.id, managed.launch.key, managed.epoch)
        if (purpose === 'previous') {
          const needsStart =
            locked.box.state === BoxState.STARTED && locked.box.desiredState === BoxDesiredState.STARTED
          await locked.manager.update(
            Box,
            { id: box.id, organizationId: box.organizationId },
            {
              prevRunnerId: null,
              ...(needsStart ? { state: BoxState.UNKNOWN, pending: true } : {}),
            },
          )
          box.prevRunnerId = null
          if (needsStart) {
            box.state = BoxState.UNKNOWN
            box.pending = true
          }
        }
        if (purpose === 'destroy' || locked.box.desiredState === BoxDesiredState.DESTROYED) {
          await this.registry.releaseRetiredBinding(
            locked.manager,
            box.organizationId,
            box.id,
            managed.runnerId,
            managed.binding,
          )
          await locked.write({ ...record, managed: undefined }, undefined, null)
        }
        return true
      })
    } catch {
      return false
    }
  }

  private async abandonUnconfirmed(box: Box, control: ProtectedBootControl) {
    const retired = await this.store.locked(box.id, box.organizationId, async (locked) => {
      const record = outboundRecord(locked.box)
      const intent = record.bootstrap
      if (!intent || intent.epoch || !this.ownsRetirement(locked.box, intent.key.runner_id, 'destroy')) return false
      const pin = this.pin(locked.box, intent)
      if (!intent.claim) {
        if (pin) await this.registry.retireBootstrapInTransaction(locked.manager, pin)
        await locked.write({ ...record, bootstrap: undefined })
        return false
      }
      if (intent.retiredEpoch !== undefined) return true
      const observed = await control.readProtectedBoot(box.id, intent.key).catch(() => undefined)
      if (observed?.outcome === 'confirmed') {
        await this.confirm(locked, intent, observed)
        return false
      }
      const receipt = observed ?? (await control.retireProtectedBoot(box.id, intent.key).catch(() => undefined))
      if (receipt?.outcome !== 'retired') return false
      await locked.write({ ...record, bootstrap: { ...intent, retiredEpoch: receipt.epoch } })
      return true
    })
    if (!retired) return
    await this.store.locked(box.id, box.organizationId, async (locked) => {
      const record = outboundRecord(locked.box)
      const intent = record.bootstrap
      if (
        !intent ||
        intent.retiredEpoch === undefined ||
        intent.epoch ||
        !this.ownsRetirement(locked.box, intent.key.runner_id, 'destroy')
      )
        return
      await control.removeRetiredEpoch(box.id, intent.key, intent.retiredEpoch)
      const pin = this.pin(locked.box, intent)
      if (pin) await this.registry.retireBootstrapInTransaction(locked.manager, pin)
      await locked.write({ ...record, bootstrap: undefined })
    })
  }

  private async beginRestart(box: Box): Promise<Box> {
    return this.store.locked(box.id, box.organizationId, async (locked) => {
      const record = outboundRecord(locked.box)
      const managed = record.managed
      if (
        record.bootstrap ||
        !managed?.retirement?.resolved ||
        locked.box.prevRunnerId ||
        locked.box.desiredState !== BoxDesiredState.STARTED
      )
        return locked.box
      const { binding, runnerId, epoch } = managed
      const name = binding
        ? await this.registry.nameForRegistration(locked.manager, box.organizationId, binding.registration_id)
        : null
      if (binding && !name) return locked.box
      const bootstrap = await this.makeIntent(locked.manager, locked.box, name, { binding, runnerId, epoch })
      await locked.write({
        ...record,
        bootstrap: { ...bootstrap, restart: locked.box.runnerId === runnerId },
      })
      return locked.box
    })
  }

  private ownsRetirement(box: Box, runnerId: string, purpose: Retirement): boolean {
    if (purpose === 'previous') {
      return (
        box.prevRunnerId === runnerId &&
        box.runnerId !== runnerId &&
        [BoxDesiredState.STARTED, BoxDesiredState.DESTROYED].includes(box.desiredState)
      )
    }
    return (
      box.runnerId === runnerId &&
      !box.prevRunnerId &&
      box.desiredState === (purpose === 'destroy' ? BoxDesiredState.DESTROYED : BoxDesiredState.STOPPED)
    )
  }

  private recoveryPin(intent: BootstrapIntent) {
    return intent.recovery?.binding
      ? { runnerId: intent.recovery.runnerId, binding: intent.recovery.binding }
      : undefined
  }

  private ownsStart(box: Box, intent: BootstrapIntent): boolean {
    return box.runnerId === intent.key.runner_id && !box.prevRunnerId && box.desiredState === BoxDesiredState.STARTED
  }

  private pin(box: Box, intent: BootstrapIntent): ProxyReservation<null> | null {
    const { key } = intent
    return key.registration_id === null
      ? null
      : {
          organizationId: box.organizationId,
          boxId: box.id,
          runnerId: key.runner_id,
          attemptId: key.attempt_id,
          runtimeEpoch: null,
          registrationId: key.registration_id,
          revision: Number(key.registration_revision),
        }
  }
}
