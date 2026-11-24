import { ConflictException, HttpException, Injectable } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { DataSource, EntityManager } from 'typeorm'
import { Box } from '../entities/box.entity'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { BoxState } from '../enums/box-state.enum'
import { ProxyRegistryStore } from '../outbound-proxy/proxy-registry.store'
import { OutboundControl, OutboundSnapshot, validOutboundSnapshot } from '../runner-adapter/outbound-control'
import {
  ManagedBinding,
  ManagedReceipt,
  ManagedSnapshot,
  ManagedUpdate,
  sameManagedSnapshot,
} from '../runner-adapter/protected-outbound'
import {
  LockedOutboundBox,
  OutboundPolicyStore,
  outboundRecord,
  persistedOutbound,
} from '../stores/outbound-policy.store'
import {
  ConfirmedManagedUpdate,
  confirmsManagedApply,
  managedUnbindMarker,
  ManagedRunnerControl,
  reconcileManagedOutbound,
} from './managed-outbound-reconciliation'
import type { OutboundPrecondition } from './outbound-policy.coordinator'

type Control = (box: Box, manager?: EntityManager) => Promise<OutboundControl>
type RegistrationInfo = { id: string; name: string; current_revision: number }
const workBatchSize = 16
const conflict = () => new ConflictException('Managed outbound state is unavailable or unresolved')
const blocked = (message = conflict().message) => new ConflictException({ message, code: 'outbound_update_blocked' })
const unconfirmed = (message = conflict().message) =>
  new ConflictException({ message, code: 'outbound_application_unconfirmed' })
const retryAfter = () => new Date(Date.now() + 30_000)

@Injectable()
export class ManagedOutboundCoordinator {
  private readonly store: OutboundPolicyStore

  constructor(
    source: DataSource,
    private readonly registry: ProxyRegistryStore,
  ) {
    this.store = new OutboundPolicyStore(source)
  }

  async read(id: string, org: string) {
    const { snapshot, record, registrations } = await this.view(id, org)
    const committed = this.redacted(registrations, record.managed?.binding)
    return {
      ...snapshot,
      policy: { ...snapshot.policy, ...(committed !== undefined ? { proxy: committed?.name ?? null } : {}) },
    }
  }

  async recognizes(id: string, org: string) {
    return !!outboundRecord(await this.store.read(id, org)).managed
  }

  async status(id: string, org: string, control: Control) {
    const { box, record, snapshot, registrations } = await this.view(id, org)
    const managed = record.managed
    const boot = record.bootstrap
    if (!managed && !boot) return undefined
    const pending =
      managed?.restoration?.candidate ??
      managed?.pending?.candidate ??
      (boot
        ? {
            snapshot: boot.key.policy,
            binding: boot.key.registration_id
              ? {
                  registration_id: boot.key.registration_id,
                  registration_revision: boot.key.registration_revision,
                  epoch: boot.epoch,
                }
              : null,
          }
        : undefined)
    const committed = this.redacted(registrations, managed?.binding)
    const staged = pending && {
      policy_revision: pending.snapshot.revision,
      proxy: this.redacted(registrations, pending.binding),
    }
    const desired = this.redacted(registrations, pending ? pending.binding : managed?.binding, true)
    let receipt: ManagedReceipt | undefined
    if (
      managed &&
      !boot &&
      !managed.retirement &&
      !box.prevRunnerId &&
      managed.runnerId === box.runnerId &&
      box.state === BoxState.STARTED
    ) {
      receipt = await (await control(box).catch(() => undefined))
        ?.managed?.(managed.epoch, { operation: 'inspect' })
        .catch(() => undefined)
      if (receipt) {
        const latest = await this.store.read(id, org)
        const live = outboundRecord(latest)
        if (
          latest.runnerId !== box.runnerId ||
          latest.prevRunnerId ||
          live.bootstrap ||
          live.managed?.retirement ||
          live.revision !== record.revision ||
          live.managed?.epoch !== managed.epoch ||
          receipt.runner_id !== managed.runnerId ||
          receipt.epoch !== managed.epoch
        )
          receipt = undefined
      }
    }
    const installed = receipt?.installed
    const installedProxy = installed ? this.redacted(registrations, installed.binding) : undefined
    const confirmed =
      !!managed &&
      !managed.pending &&
      !managed.unbindRelease &&
      !record.pending &&
      receipt?.pending_attempt === null &&
      receipt.unbind_settlement === null &&
      installedProxy !== undefined &&
      this.confirms(receipt, { snapshot, binding: managed.binding })
    return {
      persisted: snapshot,
      runtime_persisted: receipt?.durable.snapshot ?? snapshot,
      observed: installed ? { ...installed.snapshot, application_state: 'confirmed' } : null,
      application_state: confirmed ? 'confirmed' : staged || record.pending ? 'pending' : 'uncertain',
      ...(staged ? { pending_revision: staged.policy_revision } : {}),
      capabilities: ['revision-v1', 'managed-proxy-v1'],
      proxy: {
        desired: desired ?? null,
        committed: committed ?? null,
        pending: staged ?? null,
        installed:
          installed && installedProxy !== undefined
            ? { policy_revision: installed.snapshot.revision, proxy: installedProxy }
            : null,
        runtime_readback: receipt ? 'authenticated' : 'unknown',
      },
    }
  }

  private view(id: string, org: string) {
    return this.store.view(id, org, async (box, manager) => {
      const record = outboundRecord(box)
      const ids = [
        record.bootstrap?.key.registration_id,
        record.managed?.binding?.registration_id,
        record.managed?.pending?.candidate.binding?.registration_id,
      ].filter((key): key is string => !!key)
      const rows: RegistrationInfo[] = ids.length
        ? await manager.query(
            'SELECT id, name, current_revision FROM outbound_proxy_registration WHERE organization_id = $1 AND id = ANY($2::uuid[])',
            [org, ids],
          )
        : []
      return { box, record, snapshot: persistedOutbound(box), registrations: new Map(rows.map((row) => [row.id, row])) }
    })
  }

  private redacted(
    registrations: Map<string, RegistrationInfo>,
    binding: ManagedBinding | null | undefined,
    desired = false,
  ) {
    if (!binding) return binding as null | undefined
    const registration = registrations.get(binding.registration_id)
    return registration
      ? {
          name: registration.name,
          revision: desired ? registration.current_revision : Number(binding.registration_revision),
        }
      : undefined
  }

  async replace(
    id: string,
    org: string,
    policy: OutboundSnapshot['policy'],
    proxy: string | null | undefined,
    control: Control,
    matches?: OutboundPrecondition,
    rollout?: { registrationId: string; revision: number },
  ): Promise<Box> {
    const snapshot = { revision: randomUUID(), policy }
    if (!validOutboundSnapshot(snapshot)) throw blocked('Invalid managed outbound policy')
    const attemptId = randomUUID()
    const disposition = await this.store.locked(id, org, async (locked) => {
      let record = outboundRecord(locked.box)
      const runner = await this.runner(locked, control).catch((error: unknown) => {
        if (error instanceof ConflictException) throw blocked(error.message)
        throw error
      })
      if ((record.managed.pending || record.managed.unbindRelease) && !(await reconcileManagedOutbound(locked, runner)))
        return 'busy'
      record = outboundRecord(locked.box)
      const current = { snapshot: persistedOutbound(locked.box), binding: record.managed.binding }
      if (matches && !matches(current.snapshot.revision)) return 'stale'
      if (proxy === undefined && current.binding) return 'busy'
      if (
        rollout &&
        (current.binding?.registration_id !== rollout.registrationId ||
          Number(current.binding.registration_revision) >= rollout.revision)
      )
        return 'busy'
      const status = await runner({ operation: 'inspect' }).catch(() => undefined)
      if (status?.pending_attempt !== null || !this.confirms(status, current) || status.unbind_settlement !== null)
        return 'busy'
      const binding = await this.registry.reserveUpdateInTransaction(
        locked.manager,
        this.owner(locked.box, record.managed.epoch, attemptId),
        current.binding,
        proxy ?? null,
      )
      if (
        rollout &&
        (binding?.registration_id !== rollout.registrationId ||
          Number(binding.registration_revision) !== rollout.revision)
      )
        throw conflict()
      await locked.write(
        {
          ...record,
          managed: {
            ...record.managed,
            pending: {
              attempt_id: attemptId,
              predecessor: current,
              candidate: { snapshot: rollout ? { ...snapshot, policy: current.snapshot.policy } : snapshot, binding },
            },
          },
        },
        undefined,
        retryAfter(),
      )
      return 'reserved'
    })
    if (disposition === 'stale') throw new HttpException('Outbound precondition failed', 412)
    if (disposition !== 'reserved') throw blocked()
    const box = await this.advance(id, org, control, attemptId).catch((error: unknown) => {
      if (error instanceof HttpException && error.getStatus() === 409) throw unconfirmed(error.message)
      throw error
    })
    if (outboundRecord(box).revision !== snapshot.revision) throw unconfirmed()
    // The commit above must be visible before the Runtime unbind fence is released.
    if (outboundRecord(box).managed?.unbindRelease) {
      await this.advance(id, org, control).catch(() => undefined)
    }
    return box
  }

  async poll(control: Control, previous?: (box: Box) => Promise<void>): Promise<number> {
    const pending = await this.store.claimManagedWork(workBatchSize / 2)
    const rollout = await this.registry.claimRolloutWork(workBatchSize - pending.length)
    pending.push(...(await this.store.claimManagedWork(workBatchSize - pending.length - rollout.length)))
    const work = await Promise.allSettled([
      ...pending.map(async ({ id, organizationId }) => {
        const box = await this.store.read(id, organizationId)
        if (box.prevRunnerId) return previous?.(box)
        return this.advance(id, organizationId, control)
      }),
      ...rollout.map(({ id, organizationId, name, registrationId, revision }) =>
        this.replace(id, organizationId, { mode: 'disabled', allow_net: [] }, name, control, undefined, {
          registrationId,
          revision,
        }),
      ),
    ])
    await this.registry.completeRollouts()
    return work.filter(({ status }) => status === 'rejected').length
  }

  async advance(id: string, org: string, control: Control, expectedAttempt?: string): Promise<Box> {
    let confirmed: ConfirmedManagedUpdate | undefined
    try {
      return await this.advanceAttempt(
        id,
        org,
        control,
        (update) => {
          confirmed = update
        },
        expectedAttempt,
      )
    } catch (cause) {
      if (!confirmed) throw cause
      // Reacquire the primary owner lock before distinguishing a lost COMMIT reply from a failed publication.
      const recovery = await this.recoverFailedPublication(id, org, control, confirmed).catch(() => undefined)
      if (recovery?.committed) return recovery.box
      if (recovery) await this.advanceAttempt(id, org, control).catch(() => undefined)
      throw cause
    }
  }

  private async recoverFailedPublication(id: string, org: string, control: Control, confirmed: ConfirmedManagedUpdate) {
    const { update: failed, runnerId, epoch } = confirmed
    return this.store.locked(id, org, async (locked) => {
      const record = outboundRecord(locked.box)
      const managed = record.managed
      if (
        managed?.runnerId !== runnerId ||
        managed.epoch !== epoch ||
        runnerId !== locked.box.runnerId ||
        locked.box.prevRunnerId ||
        record.bootstrap
      )
        return undefined
      const current = { snapshot: persistedOutbound(locked.box), binding: managed.binding }
      if (!managed.pending && sameManagedSnapshot(current, failed.candidate)) {
        return { box: locked.box, committed: true }
      }
      const pending = managed.pending
      if (
        managed.retirement ||
        managed.restoration ||
        pending?.attempt_id !== failed.attempt_id ||
        !sameManagedSnapshot(current, failed.predecessor) ||
        !sameManagedSnapshot(pending.predecessor, failed.predecessor) ||
        !sameManagedSnapshot(pending.candidate, failed.candidate)
      )
        return undefined
      const runner = await this.runner(locked, control)
      const owner = this.owner(locked.box, managed.epoch, failed.attempt_id)
      const restoration = {
        attempt_id: randomUUID(),
        predecessor: failed.candidate,
        candidate: { ...failed.predecessor, snapshot: { ...failed.predecessor.snapshot, revision: randomUUID() } },
      }
      await this.registry.reserveRestoration(locked.manager, owner, failed, restoration)
      if (!confirmsManagedApply(await runner({ operation: 'inspect' }), failed)) throw conflict()
      await locked.write({ ...record, managed: { ...managed, restoration, claim: undefined } }, undefined, new Date())
      return { box: locked.box, committed: false }
    })
  }

  private async advanceAttempt(
    id: string,
    org: string,
    control: Control,
    confirmed?: (update: ConfirmedManagedUpdate) => void,
    expectedAttempt?: string,
  ): Promise<Box> {
    const claim = randomUUID()
    const result = await this.store.locked(id, org, async (locked) => {
      const runner = await this.runner(locked, control)
      const record = outboundRecord(locked.box)
      const managed = record.managed
      if (!managed.pending && !managed.unbindRelease) return { box: locked.box }
      if (expectedAttempt && managed.pending?.attempt_id !== expectedAttempt) return { box: locked.box }
      if (await reconcileManagedOutbound(locked, runner, undefined, confirmed)) return { box: locked.box }
      const pending = outboundRecord(locked.box).managed?.pending
      if (!pending) return { box: locked.box }
      const restoration = managed.restoration
      const update = restoration ?? pending
      const current = await this.lockUpdate(locked, pending, restoration)
      if (managed.claim || !current) {
        if (!restoration) await this.retire(locked, runner, pending)
        return { box: locked.box }
      }
      const marker = await runner(
        restoration ? { operation: 'prepare_restore', failed: pending, update } : { operation: 'prepare', update },
      ).catch(() => undefined)
      if (
        marker?.pending_attempt !== update.attempt_id ||
        !this.confirms(marker, update.predecessor) ||
        marker.unbind_settlement !== (restoration ? managedUnbindMarker(pending) : null)
      )
        return { box: locked.box }
      await locked.write({ ...record, managed: { ...managed, claim } }, undefined, retryAfter())
      return { box: locked.box, dispatch: true }
    })
    if (!result.dispatch) return result.box

    return this.store.locked(id, org, async (locked) => {
      const runner = await this.runner(locked, control)
      const { managed } = outboundRecord(locked.box)
      const pending = managed.pending
      if (!pending || managed.claim !== claim) return locked.box
      const update = managed.restoration ?? pending
      const current = await this.lockUpdate(locked, pending, managed.restoration)
      if (!current) {
        await this.retire(locked, runner, pending)
        return locked.box
      }
      const marker = await runner({ operation: 'inspect' }).catch(() => undefined)
      if (
        marker?.pending_attempt !== update.attempt_id ||
        !this.confirms(marker, update.predecessor) ||
        marker.unbind_settlement !== (managed.restoration ? managedUnbindMarker(pending) : null)
      )
        return locked.box
      const [route, predecessor_route] = await Promise.all([
        this.material(locked, update.candidate.binding),
        this.material(locked, update.predecessor.binding),
      ])
      const observed = await runner({
        operation: 'apply',
        attempt_id: update.attempt_id,
        route,
        predecessor_route,
      }).catch(() => undefined)
      await reconcileManagedOutbound(locked, runner, observed, confirmed)
      return locked.box
    })
  }

  private async lockUpdate(locked: LockedOutboundBox, pending: ManagedUpdate, restoration?: ManagedUpdate) {
    const epoch = outboundRecord(locked.box).managed.epoch
    const owner = this.owner(locked.box, epoch, pending.attempt_id)
    if (!restoration) return this.registry.lockUpdateVersions(locked.manager, owner, pending)
    await this.registry.lockRestorationVersions(locked.manager, owner, pending, restoration)
    return true
  }

  private async retire(locked: LockedOutboundBox, runner: ManagedRunnerControl, pending: ManagedUpdate) {
    const receipt = await runner({
      operation: 'retire_prepared',
      attempt_id: pending.attempt_id,
      predecessor: pending.predecessor,
    }).catch(() => undefined)
    if (receipt?.retired_attempt === pending.attempt_id) await reconcileManagedOutbound(locked, runner, receipt)
  }

  private async runner(locked: LockedOutboundBox, control: Control): Promise<ManagedRunnerControl> {
    const { box } = locked
    const record = outboundRecord(box)
    if (
      !record.managed ||
      record.managed.retirement ||
      record.managed.runnerId !== box.runnerId ||
      box.prevRunnerId ||
      record.bootstrap ||
      record.pending ||
      box.pending ||
      box.state !== BoxState.STARTED ||
      box.desiredState !== BoxDesiredState.STARTED
    )
      throw conflict()
    const { managed } = await control(box, locked.manager)
    if (!managed) throw conflict()
    const { epoch, runnerId } = record.managed
    return async (command) => {
      const receipt = await managed(epoch, command)
      if (receipt.runner_id !== runnerId || receipt.epoch !== epoch) throw conflict()
      return receipt
    }
  }

  private owner(box: Box, epoch: string, attemptId: string) {
    return { organizationId: box.organizationId, boxId: box.id, runnerId: box.runnerId, runtimeEpoch: epoch, attemptId }
  }

  private confirms(receipt: ManagedReceipt | undefined, expected: ManagedSnapshot): boolean {
    return (
      !!receipt?.installed &&
      sameManagedSnapshot(receipt.installed, expected) &&
      sameManagedSnapshot(receipt.durable, expected)
    )
  }

  private async material({ box, manager }: LockedOutboundBox, binding: ManagedBinding | null) {
    if (!binding) return null
    const route = await this.registry.loadPinnedRoute(
      manager,
      box.organizationId,
      binding.registration_id,
      Number(binding.registration_revision),
    )
    return { ...route, binding }
  }
}
