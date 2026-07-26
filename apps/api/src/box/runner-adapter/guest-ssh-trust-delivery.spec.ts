/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { RunnerAdapterV0 } from './runnerAdapter.v0'
import { RunnerAdapterV2 } from './runnerAdapter.v2'
import { Box } from '../entities/box.entity'
import { GuestSshTrustConfig } from '../services/ssh-certificate/guest-ssh-trust'

/**
 * Trust delivery has to behave identically on both adapters, because a
 * deployment picks one and a box created under v0 must be recoverable under
 * v2. The `volumes` field is a standing example of the two drifting, so these
 * assert on both rather than on whichever one is convenient.
 *
 * The invariant under test: the adapters *forward* the persisted bundle and
 * never resolve organization policy themselves. Resolution happens once, at
 * create, in `GuestSshTrustService`.
 */

const TRUST: GuestSshTrustConfig = {
  listenAddr: '0.0.0.0:22',
  organizationId: 'org-1',
  boxId: 'box-1',
  caKeys: [
    { keyId: 'ca-key-1', publicKey: 'ssh-ed25519 AAAACURRENT' },
    { keyId: 'ca-key-2', publicKey: 'ssh-ed25519 AAAANEXT' },
  ],
}

function makeBox(overrides: Partial<Box> = {}): Box {
  return {
    id: 'box-1',
    image: 'alpine:latest',
    osUser: 'boxlite',
    cpu: 1,
    gpu: 0,
    mem: 1,
    disk: 1,
    env: {},
    networkBlockAll: false,
    organizationId: 'org-1',
    region: 'region-1',
    guestSshTrust: TRUST,
    ...overrides,
  } as Box
}

function makeV0() {
  const create = jest.fn().mockResolvedValue({ data: { daemonVersion: '1' } })
  const recover = jest.fn().mockResolvedValue(undefined)
  const adapter = Object.create(RunnerAdapterV0.prototype) as RunnerAdapterV0
  ;(adapter as unknown as { boxApiClient: unknown }).boxApiClient = { create, recover }
  return { adapter, create, recover }
}

function makeV2() {
  const createJob = jest.fn().mockResolvedValue(undefined)
  const adapter = Object.create(RunnerAdapterV2.prototype) as RunnerAdapterV2
  ;(adapter as unknown as { jobService: unknown; runner: unknown; logger: unknown }).jobService = { createJob }
  ;(adapter as unknown as { runner: unknown }).runner = { id: 'runner-1' }
  ;(adapter as unknown as { logger: unknown }).logger = { debug: jest.fn() }
  return { adapter, createJob }
}

/** v2 stores the payload as the job's last argument. */
function v2Payload(createJob: jest.Mock): Record<string, unknown> {
  return createJob.mock.calls.at(-1)?.at(-1) as Record<string, unknown>
}

describe('guest SSH trust delivery', () => {
  describe('create', () => {
    it('forwards the persisted bundle on v0', async () => {
      const { adapter, create } = makeV0()

      await adapter.createBox(makeBox())

      expect(create.mock.calls[0][0].guestSshTrust).toEqual(TRUST)
    })

    it('forwards the persisted bundle on v2', async () => {
      const { adapter, createJob } = makeV2()

      await adapter.createBox(makeBox())

      expect(v2Payload(createJob).guestSshTrust).toEqual(TRUST)
    })

    it('sends the same bundle from both adapters', async () => {
      const v0 = makeV0()
      const v2 = makeV2()

      await v0.adapter.createBox(makeBox())
      await v2.adapter.createBox(makeBox())

      expect(v0.create.mock.calls[0][0].guestSshTrust).toEqual(v2Payload(v2.createJob).guestSshTrust)
    })

    it('omits the field entirely when the organization has no CA', async () => {
      // `null` means "this organization has no guest SSH". The generated
      // client types the field as optional (`guestSshTrust?: GuestSshTrustDTO`),
      // so `null` is not assignable and must be coerced to `undefined`. The
      // runner itself would tolerate an explicit null — its DTO field is a
      // pointer with `omitempty` — so this is a client-contract constraint,
      // not a server-validation one.
      const v0 = makeV0()
      const v2 = makeV2()
      const box = makeBox({ guestSshTrust: null })

      await v0.adapter.createBox(box)
      await v2.adapter.createBox(box)

      expect(v0.create.mock.calls[0][0].guestSshTrust).toBeUndefined()
      expect(v2Payload(v2.createJob).guestSshTrust).toBeUndefined()
    })
  })

  describe('recover', () => {
    it('replays the persisted bundle on v0 rather than re-resolving', async () => {
      const { adapter, recover } = makeV0()

      await adapter.recoverBox(makeBox())

      expect(recover.mock.calls[0][1].guestSshTrust).toEqual(TRUST)
    })

    it('replays the persisted bundle on v2 rather than re-resolving', async () => {
      const { adapter, createJob } = makeV2()

      await adapter.recoverBox(makeBox())

      expect(v2Payload(createJob).guestSshTrust).toEqual(TRUST)
    })

    it('replays a stale bundle unchanged after a CA rotation', async () => {
      // The organization may since have rotated to ca-key-3. Recover must
      // still send what the box was created with: trust is immutable for a VM
      // generation, and re-resolving here would change it under a running box.
      const stale: GuestSshTrustConfig = {
        ...TRUST,
        caKeys: [{ keyId: 'ca-key-retired', publicKey: 'ssh-ed25519 AAAAOLD' }],
      }
      const v0 = makeV0()
      const v2 = makeV2()
      const box = makeBox({ guestSshTrust: stale })

      await v0.adapter.recoverBox(box)
      await v2.adapter.recoverBox(box)

      expect(v0.recover.mock.calls[0][1].guestSshTrust).toEqual(stale)
      expect(v2Payload(v2.createJob).guestSshTrust).toEqual(stale)
    })
  })

  it('neither adapter reaches for organization CA state', () => {
    // Structural guard: resolution belongs to GuestSshTrustService at create.
    // If an adapter ever grows a CA lookup, trust stops being immutable for a
    // VM generation and stop/start starts silently rotating it.
    const sources = [
      require('fs').readFileSync(require.resolve('./runnerAdapter.v0'), 'utf8'),
      require('fs').readFileSync(require.resolve('./runnerAdapter.v2'), 'utf8'),
    ]
    for (const source of sources) {
      expect(source).not.toMatch(/caKeyService|OrganizationSshCaKey|resolveForNewBox/)
    }
  })
})
