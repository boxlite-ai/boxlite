/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { EntityManager } from 'typeorm'
import {
  ConfirmedWorkerAbsent,
  ConfirmedWorkerCreationRejected,
  decodeScope,
  ExecutionJournal,
  ExecutionLease,
  ExecutionScope,
  ListenerState,
  scopeKey,
  WorkerExecutor,
  WorkerLaunch,
} from '@boxlite-ai/ci-listener'
import { Box } from '../box/entities/box.entity'
import { BoxState } from '../box/enums/box-state.enum'
import { BoxDesiredState } from '../box/enums/box-desired-state.enum'
import { BoxService } from '../box/services/box.service'
import { BoxCreationLimitExceededError } from '../box/errors/box-creation-limit.error'
import { RunnerService } from '../box/services/runner.service'
import { CreateBoxDto } from '../box/dto/create-box.dto'
import { OrganizationService } from '../organization/services/organization.service'
import { CommerceBoxLimitService } from '../boxlite-rest/commerce-box-limit.service'
import { boxToBoxResponse } from '../boxlite-rest/mappers/box-to-box.mapper'
import { Context } from '../common/context/context'
import { PlatformReason } from '../common/context/platform-reason.enum'
import { CiNativeState } from './ci-native-state'
import { uploadJitFile } from './ci-runner-files'
type Effect = 'box-create' | 'box-stop' | 'box-remove' | 'jit-deliver'

/** Internal capability: original scope + execution lease, with no user API Key. */
@Injectable()
export class CiNativeWorkers {
  constructor(
    private readonly store: CiNativeState,
    private readonly boxes: BoxService,
    private readonly organizations: OrganizationService,
    private readonly limits: CommerceBoxLimitService,
    private readonly runners: RunnerService,
  ) {}
  open(original: ExecutionScope, originalLease: ExecutionLease): WorkerExecutor {
    const scope = decodeScope(original),
      lease = { ...originalLease },
      originalScope = scopeKey(scope)
    const inspect = async (tx: EntityManager, state: ListenerState, name: string, effect?: Effect) => {
      if (!/^ci-jit-[a-f0-9]{32}$/.test(name)) throw new ForbiddenException('Original CI worker required')
      const snapshot = await new ExecutionJournal(state).load(lease)
      await this.store.root(state)
      const allocation = snapshot.allocations.get('worker/' + name.slice(7))
      if (!allocation || allocation.value.name !== name || allocation.value.scope !== originalScope)
        throw new ForbiddenException('Original CI allocation is unavailable')
      if (effect && allocation.value.effect?.kind !== effect)
        throw new ConflictException('Durable CI effect intent required')
      if (effect === 'box-create' || effect === 'jit-deliver') {
        if (allocation.value.closing) throw new ConflictException('CI allocation is closing')
        await this.store.admit(tx, scope)
      }
      const key = 'box-native/' + name.slice(7),
        [record] = await state.read([key])
      const value = record?.payload
      if (record) {
        if (
          record.schema !== 1 ||
          !value ||
          typeof value !== 'object' ||
          Array.isArray(value) ||
          value.scope !== originalScope
        )
          throw new ForbiddenException('Original CI Box ledger changed')
        if (value.box === null) {
          if (
            allocation.value.box.phase !== 'requested' ||
            allocation.value.box.id !== null ||
            allocation.value.effect?.kind !== 'box-create' ||
            value.rejectedCreationEffect !== allocation.value.effect.id
          )
            throw new ForbiddenException('Original CI rejection operation changed')
        } else if (
          typeof value.box !== 'string' ||
          value.rejectedCreationEffect !== undefined ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(value.box) ||
          (allocation.value.box.id !== null && value.box !== allocation.value.box.id)
        )
          throw new ForbiddenException('Original CI Box ledger changed')
      }
      const payload = record?.payload as { box?: string | null; rejectedCreationEffect?: string } | undefined
      return {
        allocation: allocation.value,
        key,
        record,
        box: payload?.box ?? undefined,
        rejected: payload?.box === null ? payload.rejectedCreationEffect : undefined,
      }
    }
    const owned = async (name: string, effect?: Effect) => {
      const value = await this.store.transaction((tx, state) => inspect(tx, state, name, effect))
      if (value.rejected) throw new ConfirmedWorkerCreationRejected(value.rejected)
      if (!value.box) throw new ConflictException('Original CI Box ID is not durably known')
      let box: Box
      try {
        box = await this.boxes.findOne(value.box, true)
      } catch (error) {
        if (error instanceof NotFoundException) throw new ConfirmedWorkerAbsent()
        throw error
      }
      if (box.id !== value.box || box.organizationId !== scope.organization || box.name !== name)
        throw new ForbiddenException('Original CI Box ownership changed')
      if (box.state === BoxState.DESTROYED) throw new ConfirmedWorkerAbsent()
      return box
    }
    const context = () => Context.platform(PlatformReason.CI_RUNNER)
    const running = async (name: string) => {
      const box = await owned(name, 'jit-deliver')
      if (
        box.state !== BoxState.STARTED ||
        box.desiredState !== BoxDesiredState.STARTED ||
        box.pending ||
        !box.runnerId
      )
        throw new ConflictException('Original CI Box must be running for JIT delivery')
      return box
    }
    return {
      create: async (input) => {
        const launch: WorkerLaunch = { ...input, entrypoint: [...input.entrypoint] }
        if (
          !launch.image ||
          !Number.isInteger(launch.cpus) ||
          launch.cpus < 1 ||
          launch.cpus > 16 ||
          !Number.isInteger(launch.memoryMiB) ||
          launch.memoryMiB < 128 ||
          launch.memoryMiB > 131072 ||
          !launch.entrypoint.length ||
          launch.entrypoint.some((v) => typeof v !== 'string' || v.includes('\0'))
        )
          throw new ForbiddenException('Invalid CI worker launch')
        const creationEffect = await this.store.transaction(async (tx, state) => {
          const original = await inspect(tx, state, launch.name, 'box-create')
          if (original.record || original.allocation.box.phase !== 'requested' || original.allocation.box.id !== null)
            throw new ConflictException('CI Box creation was already attempted')
          return original.allocation.effect!.id
        })
        const organization = await this.organizations.findOne(scope.organization)
        const maxCreatedBoxes = await this.limits.resolveMaxCreatedBoxes(scope.organization)
        const dto = Object.assign(new CreateBoxDto(), {
          name: launch.name,
          image: launch.image,
          cpu: launch.cpus,
          memory: launch.memoryMiB / 1024,
          user: 'runner',
          workingDir: '/home/runner',
          entrypoint: launch.entrypoint,
          cmd: [],
          autoStop: 0,
          autoResume: false,
        })
        let persistenceEntered = false
        let created: Awaited<ReturnType<BoxService['create']>>
        try {
          created = await this.boxes.create(dto, organization, context(), {
            maxCreatedBoxes,
            onPersist: async (tx, box) => {
              persistenceEntered = true
              const state = this.store.inside(tx)
              const original = await inspect(tx, state, launch.name, 'box-create')
              if (
                box.organizationId !== scope.organization ||
                box.name !== launch.name ||
                original.record ||
                original.allocation.box.phase !== 'requested' ||
                original.allocation.box.id !== null
              )
                throw new ForbiddenException('Original CI persistence intent changed')
              await state.commit(lease, [
                { key: original.key, expected: null, payload: { scope: originalScope, box: box.id } },
              ])
            },
          })
        } catch (error) {
          if (!(error instanceof BoxCreationLimitExceededError) || persistenceEntered) throw error
          await this.store.transaction(async (tx, state) => {
            // This is cleanup of a rejected original operation, not authority to start new work.
            const original = await inspect(tx, state, launch.name)
            if (
              original.record ||
              original.allocation.box.phase !== 'requested' ||
              original.allocation.box.id !== null ||
              original.allocation.effect?.kind !== 'box-create' ||
              original.allocation.effect.id !== creationEffect
            )
              throw new ConflictException('Original CI creation rejection cannot be recorded')
            // One ledger key arbitrates persisted Box IDs and definitive refusal facts.
            // A racing onPersist must lose the same expected-null CAS and roll back its Box row.
            await state.commit(lease, [
              {
                key: original.key,
                expected: null,
                payload: { scope: originalScope, box: null, rejectedCreationEffect: creationEffect },
              },
            ])
          })
          throw new ConfirmedWorkerCreationRejected(creationEffect)
        }
        return boxToBoxResponse(created)
      },
      get: async (name) => {
        const box = await owned(name)
        const response = boxToBoxResponse(await this.boxes.toBoxDtoWithExitCode(box))
        if (box.state === BoxState.ERROR) response.status = 'error'
        return response
      },
      stop: async (name) => {
        const box = await owned(name, 'box-stop')
        if (box.state === BoxState.STOPPED) return
        await this.store.transaction((tx, state) => inspect(tx, state, name, 'box-stop'))
        await this.boxes.stop(box.id, scope.organization, context(), true, 'id')
      },
      remove: async (name) => {
        const box = await owned(name, 'box-remove')
        if (box.state === BoxState.DESTROYING) return
        if (![BoxState.STOPPED, BoxState.ERROR].includes(box.state))
          throw new ConflictException('CI Box must stop before deletion')
        await this.store.transaction((tx, state) => inspect(tx, state, name, 'box-remove'))
        await this.boxes.destroy(box.id, scope.organization, context(), 'id')
      },
      deliverJit: async (name, jit, signal) => {
        if (
          typeof jit !== 'string' ||
          !jit.length ||
          jit.length > 1048576 ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(jit)
        )
          throw new ForbiddenException('Bounded base64 JIT configuration required')
        signal?.throwIfAborted()
        const original = await running(name)
        await this.store.transaction(async (tx, state) => {
          const value = await inspect(tx, state, name, 'jit-deliver')
          if (
            value.allocation.delivery !== 'requested' ||
            !value.record ||
            typeof value.record.payload !== 'object' ||
            value.record.payload === null ||
            Array.isArray(value.record.payload) ||
            value.record.payload.delivery !== undefined
          )
            throw new ConflictException('CI JIT delivery was already attempted')
          await state.commit(lease, [
            {
              key: value.key,
              expected: value.record.version,
              payload: { ...value.record.payload, delivery: randomUUID() },
            },
          ])
        })
        for (const [file, content] of [
          ['.boxlite-jitconfig', jit],
          ['.boxlite-jitconfig.ready', 'ready'],
        ] as const) {
          signal?.throwIfAborted()
          const runner = await this.runners.findOneUncachedOrFail(original.runnerId!)
          const current = await running(name)
          if (current.id !== original.id || current.runnerId !== original.runnerId)
            throw new ForbiddenException('Original CI runner assignment changed')
          // The resource lookup can wait across revocation or lease takeover.
          // Fence again after it returns, immediately before the HTTP effect.
          await this.store.transaction((tx, state) => inspect(tx, state, name, 'jit-deliver'))
          signal?.throwIfAborted()
          await uploadJitFile(runner.apiUrl || runner.proxyUrl, runner.apiKey, original.id, file, content, signal)
        }
      },
    }
  }
}
