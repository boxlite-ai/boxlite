/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

// Unit-test AdminOverviewService aggregation logic.
//
// The RunnerService module graph pulls in ESM-only deps (uuid v9) that Jest's
// CommonJS transform cannot parse. We hoist jest.mock() calls for every module
// in that chain before any import is resolved, which keeps the test in the
// CommonJS world while still exercising the real AdminOverviewService code.

jest.mock('../../sandbox/services/runner.service', () => ({ RunnerService: class RunnerService {} }))
jest.mock('../../sandbox/repositories/sandbox.repository', () => ({ SandboxRepository: class SandboxRepository {} }))
jest.mock('../../user/user.service', () => ({ UserService: class UserService {} }))

import { AdminOverviewService } from './overview.service'
import { RunnerState } from '../../sandbox/enums/runner-state.enum'
import { SandboxState } from '../../sandbox/enums/sandbox-state.enum'
import { SystemRole } from '../../user/enums/system-role.enum'

// ─── Minimal test fixtures ───────────────────────────────────────────────────

function makeRunnerDto(
  overrides: Partial<{
    id: string
    state: RunnerState
    cpu: number
    currentAllocatedCpu: number
    currentCpuUsagePercentage: number
    currentMemoryUsagePercentage: number
    currentStartedSandboxes: number
    region: string
  }> = {},
) {
  return {
    id: overrides.id ?? 'runner-1',
    state: overrides.state ?? RunnerState.READY,
    cpu: overrides.cpu ?? 8,
    currentAllocatedCpu: overrides.currentAllocatedCpu ?? 4,
    currentCpuUsagePercentage: overrides.currentCpuUsagePercentage ?? 50,
    currentMemoryUsagePercentage: overrides.currentMemoryUsagePercentage ?? 60,
    currentStartedSandboxes: overrides.currentStartedSandboxes ?? 3,
    region: overrides.region ?? 'us-east-1',
  }
}

function makeUser(overrides: Partial<{ id: string; email: string; name: string; role: SystemRole }> = {}) {
  return {
    id: overrides.id ?? 'usr-1',
    email: overrides.email ?? 'alice@example.com',
    name: overrides.name ?? 'Alice',
    role: overrides.role ?? SystemRole.USER,
  }
}

function makeSandbox(
  overrides: Partial<{
    id: string
    organizationId: string
    state: SandboxState
    runnerId?: string
    cpu: number
    mem: number
  }> = {},
) {
  return {
    id: overrides.id ?? 'sb-1',
    organizationId: overrides.organizationId ?? 'org-1',
    state: overrides.state ?? SandboxState.STARTED,
    runnerId: overrides.runnerId,
    cpu: overrides.cpu ?? 2,
    mem: overrides.mem ?? 4,
    createdAt: new Date('2024-01-01T00:00:00Z'),
  }
}

function makeSandboxStateCountRows(sandboxes: ReturnType<typeof makeSandbox>[]) {
  const counts = new Map<SandboxState, number>()
  for (const sandbox of sandboxes) {
    counts.set(sandbox.state, (counts.get(sandbox.state) ?? 0) + 1)
  }

  return Array.from(counts.entries()).map(([state, count]) => ({ state, count: String(count) }))
}

// ─── Build service with stub collaborators ───────────────────────────────────

function buildService(stubs: {
  users?: ReturnType<typeof makeUser>[]
  runners?: ReturnType<typeof makeRunnerDto>[]
  drainingRunners?: ReturnType<typeof makeRunnerDto>[]
  sandboxes?: ReturnType<typeof makeSandbox>[]
  sandboxStateCounts?: { state: SandboxState; count: string }[]
}): AdminOverviewService {
  const userService = {
    findAll: jest.fn().mockResolvedValue(stubs.users ?? []),
  } as any

  const runnerService = {
    findAllFull: jest.fn().mockResolvedValue(stubs.runners ?? []),
    findDrainingPaginated: jest.fn().mockResolvedValue(stubs.drainingRunners ?? []),
  } as any

  const sandboxStateCounts = stubs.sandboxStateCounts ?? makeSandboxStateCountRows(stubs.sandboxes ?? [])
  const sandboxStateCountQuery = {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue(sandboxStateCounts),
  }
  const sandboxRepository = {
    find: jest.fn().mockResolvedValue(stubs.sandboxes ?? []),
    createQueryBuilder: jest.fn().mockReturnValue(sandboxStateCountQuery),
  } as any

  return new AdminOverviewService(userService, runnerService, sandboxRepository)
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('AdminOverviewService', () => {
  // ── getOverview ──────────────────────────────────────────────────────────

  describe('getOverview', () => {
    it('counts users, active boxes, and runner states correctly', async () => {
      const service = buildService({
        users: [makeUser(), makeUser({ id: 'usr-2' })],
        runners: [
          makeRunnerDto({ id: 'r1', state: RunnerState.READY }),
          makeRunnerDto({ id: 'r2', state: RunnerState.INITIALIZING }),
          makeRunnerDto({ id: 'r3', state: RunnerState.READY }),
        ],
        sandboxes: [makeSandbox(), makeSandbox({ id: 'sb-2' })],
        drainingRunners: [makeRunnerDto({ id: 'r1' })],
      })

      const result = await service.getOverview()

      expect(result.users).toBe(2)
      expect(result.activeBoxes).toBe(2)
      expect(result.runners.total).toBe(3)
      expect(result.runners.online).toBe(2)
      expect(result.runners.draining).toBe(1)
    })

    it('returns zeros when no runners exist (guards divide-by-zero)', async () => {
      const service = buildService({ users: [], runners: [], sandboxes: [], drainingRunners: [] })

      const result = await service.getOverview()

      expect(result.cluster.cpuUtil).toBe(0)
      expect(result.cluster.oversell).toBe(0)
    })

    it('computes oversell as totalAllocated / totalCpu across all runners', async () => {
      const service = buildService({
        runners: [
          makeRunnerDto({ cpu: 10, currentAllocatedCpu: 5, currentCpuUsagePercentage: 0 }),
          makeRunnerDto({ cpu: 10, currentAllocatedCpu: 10, currentCpuUsagePercentage: 0 }),
        ],
        sandboxes: [],
        drainingRunners: [],
      })

      const result = await service.getOverview()

      // totalAllocated = 15, totalCpu = 20 → oversell = 0.75
      expect(result.cluster.oversell).toBeCloseTo(0.75)
    })

    it('computes average cpuUtil from currentCpuUsagePercentage / 100', async () => {
      const service = buildService({
        runners: [makeRunnerDto({ currentCpuUsagePercentage: 40 }), makeRunnerDto({ currentCpuUsagePercentage: 60 })],
        sandboxes: [],
        drainingRunners: [],
      })

      const result = await service.getOverview()

      // avg = (40 + 60) / 2 / 100 = 0.5
      expect(result.cluster.cpuUtil).toBeCloseTo(0.5)
    })

    it('averages cpuUtil over online (READY) runners only', async () => {
      const service = buildService({
        runners: [
          makeRunnerDto({ id: 'r1', state: RunnerState.READY, currentCpuUsagePercentage: 60 }),
          makeRunnerDto({ id: 'r2', state: RunnerState.INITIALIZING, currentCpuUsagePercentage: 0 }),
          makeRunnerDto({ id: 'r3', state: RunnerState.UNRESPONSIVE, currentCpuUsagePercentage: 0 }),
        ],
        sandboxes: [],
        drainingRunners: [],
      })

      const result = await service.getOverview()

      expect(result.cluster.cpuUtil).toBeCloseTo(0.6)
    })

    it('returns box status breakdown with total and counts by state', async () => {
      const service = buildService({
        sandboxes: [
          makeSandbox({ id: 'sb-started', state: SandboxState.STARTED }),
          makeSandbox({ id: 'sb-error-1', state: SandboxState.ERROR }),
          makeSandbox({ id: 'sb-error-2', state: SandboxState.ERROR }),
          makeSandbox({ id: 'sb-build-failed', state: SandboxState.BUILD_FAILED }),
        ],
        runners: [],
        drainingRunners: [],
      })

      const result = await service.getOverview()

      expect(result.boxes).toEqual({
        total: 4,
        byState: {
          [SandboxState.STARTED]: 1,
          [SandboxState.ERROR]: 2,
          [SandboxState.BUILD_FAILED]: 1,
        },
      })
      expect(result.activeBoxes).toBe(1)
    })
  })

  // ── listUsers ────────────────────────────────────────────────────────────

  describe('listUsers', () => {
    it('maps user entity fields to AdminUserItemDto', async () => {
      const service = buildService({
        users: [makeUser({ id: 'u1', email: 'bob@x.com', name: 'Bob', role: SystemRole.ADMIN })],
      })

      const result = await service.listUsers()

      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({ id: 'u1', email: 'bob@x.com', name: 'Bob', role: SystemRole.ADMIN })
    })
  })

  // ── listBoxes ────────────────────────────────────────────────────────────

  describe('listBoxes', () => {
    it('maps sandbox entity fields to AdminBoxItemDto', async () => {
      const service = buildService({
        sandboxes: [
          makeSandbox({
            id: 'sb-1',
            organizationId: 'org-1',
            state: SandboxState.STARTED,
            runnerId: 'r1',
            cpu: 2,
            mem: 4,
          }),
        ],
      })

      const result = await service.listBoxes()

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('sb-1')
      expect(result[0].organizationId).toBe('org-1')
      expect(result[0].state).toBe(SandboxState.STARTED)
      expect(result[0].runnerId).toBe('r1')
      expect(result[0].cpu).toBe(2)
      expect(result[0].memoryGiB).toBe(4)
      expect(result[0].createdAt).toBe('2024-01-01T00:00:00.000Z')
    })
  })

  // ── listRunners ──────────────────────────────────────────────────────────

  describe('listRunners', () => {
    it('merges draining flag from findDrainingPaginated into runner DTOs', async () => {
      const service = buildService({
        runners: [makeRunnerDto({ id: 'r1' }), makeRunnerDto({ id: 'r2' })],
        drainingRunners: [makeRunnerDto({ id: 'r1' })],
      })

      const result = await service.listRunners()

      const r1 = result.find((r) => r.id === 'r1')!
      const r2 = result.find((r) => r.id === 'r2')!
      expect(r1.draining).toBe(true)
      expect(r2.draining).toBe(false)
    })
  })

  // ── listMachines ─────────────────────────────────────────────────────────

  describe('listMachines', () => {
    it('computes oversellCpu as currentAllocatedCpu / cpu', async () => {
      const service = buildService({
        runners: [
          makeRunnerDto({
            id: 'r1',
            cpu: 8,
            currentAllocatedCpu: 6,
            currentCpuUsagePercentage: 70,
            currentMemoryUsagePercentage: 50,
            currentStartedSandboxes: 4,
            region: 'us-east-1',
          }),
        ],
      })

      const result = await service.listMachines()

      expect(result).toHaveLength(1)
      expect(result[0].host).toBe('r1')
      expect(result[0].region).toBe('us-east-1')
      expect(result[0].oversellCpu).toBeCloseTo(6 / 8)
      expect(result[0].cpuWaterline).toBe(70)
      expect(result[0].memWaterline).toBe(50)
      expect(result[0].sandboxes).toBe(4)
    })

    it('guards divide-by-zero: oversellCpu = 0 when runner cpu capacity = 0', async () => {
      const service = buildService({
        runners: [makeRunnerDto({ cpu: 0, currentAllocatedCpu: 0 })],
      })

      const result = await service.listMachines()

      expect(result[0].oversellCpu).toBe(0)
    })
  })
})
