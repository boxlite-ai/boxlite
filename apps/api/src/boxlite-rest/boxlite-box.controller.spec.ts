/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import 'reflect-metadata'
import { BadRequestException, CallHandler, ExecutionContext, ValidationPipe } from '@nestjs/common'
import { PIPES_METADATA } from '@nestjs/common/constants'
import { Reflector } from '@nestjs/core'
import { firstValueFrom, of } from 'rxjs'
import { AuditAction } from '../audit/enums/audit-action.enum'
import { AuditTarget } from '../audit/enums/audit-target.enum'
import { AuditInterceptor } from '../audit/interceptors/audit.interceptor'
import { RequiredOrganizationResourcePermissions } from '../organization/decorators/required-organization-resource-permissions.decorator'
import { OrganizationResourcePermission } from '../organization/enums/organization-resource-permission.enum'
import { BoxliteBoxController } from './boxlite-box.controller'
import { CreateBoxDto } from './dto/create-box.dto'

// `openapi/box.openapi.yaml` declares `additionalProperties: false` on
// CreateBoxRequest, and both other servers enforce it — `boxlite serve` via
// `#[serde(deny_unknown_fields)]`, the reference server via
// `extra="forbid"`. This controller has to agree, or a caller can hand it a
// sandbox knob and get a 201 plus a box that ignored it.
//
// The pipe is read off the controller class rather than reconstructed here:
// a locally-built pipe would pass even if the @UsePipes decorator were
// deleted, which is the failure this is meant to catch.
describe('BoxliteBoxController request validation', () => {
  const pipes: unknown[] = Reflect.getMetadata(PIPES_METADATA, BoxliteBoxController) ?? []
  const pipe = pipes.find((candidate): candidate is ValidationPipe => candidate instanceof ValidationPipe)
  const meta = { type: 'body' as const, metatype: CreateBoxDto }

  it('installs a ValidationPipe on the controller', () => {
    expect(pipe).toBeDefined()
  })

  it.each([
    ['a security preset', { security: 'development' }],
    ['a sandbox security object', { advanced: { security: { jailer_enabled: false } } }],
    ['privileged mode', { privileged: true }],
    ['an unrecognised field', { totally_made_up: 1 }],
  ])('rejects %s', async (_label, extra) => {
    await expect(pipe!.transform({ image: 'alpine:latest', ...extra }, meta)).rejects.toThrow()
  })

  // Fields the spec declares and the other two servers implement, but this one
  // does not. Whitelisting alone would report them as "property X should not
  // exist"; each carries a message saying why and what to do instead. The
  // assertion is on the message, so deleting a constraint and falling back to
  // the generic whitelist error is a failure, not a silent pass.
  it.each([
    ['rootfs_path', { rootfs_path: '/srv/rootfs' }, 'local-only'],
    ['advanced', { advanced: { capabilities: { add: ['SYS_ADMIN'] } } }, 'not supported for cloud'],
    ['tty', { tty: true }, 'not supported for cloud'],
    ['ports', { ports: [{ guest_port: 3000 }] }, 'local-only'],
  ])('rejects %s with an actionable message', async (_label, extra, fragment) => {
    // BadRequestException.message is the generic "Bad Request Exception";
    // class-validator's per-field messages live in the response body.
    const error = await pipe!.transform({ image: 'alpine:latest', ...extra }, meta).then(
      () => null,
      (e: BadRequestException) => e,
    )

    expect(error).toBeInstanceOf(BadRequestException)
    const body = error!.getResponse() as { message: string[] }
    expect(body.message.join(' | ')).toContain(fragment)
  })

  // Only asking for a terminal is refused. `false` is the schema default
  // (openapi/box.openapi.yaml), so a client may send it explicitly even though
  // no in-repo one does — rest/types.rs sends tty via then_some(true), which
  // omits the key entirely when it is false.
  it('accepts tty: false as a no-op', async () => {
    const dto: CreateBoxDto = await pipe!.transform({ image: 'alpine:latest', tty: false }, meta)

    expect(dto.tty).toBe(false)
  })

  it('rejects an unrecognised field nested inside network', async () => {
    await expect(
      pipe!.transform({ image: 'alpine:latest', network: { outbound: { mode: 'enabled' }, bogus: 1 } }, meta),
    ).rejects.toThrow()
  })

  // The guard above is worthless if it also rejects the bodies the API is
  // supposed to serve, so pin the supported surface against the same pipe.
  it('accepts a fully-populated supported body', async () => {
    const dto: CreateBoxDto = await pipe!.transform(
      {
        name: 'dev-box',
        image: 'python:3.11-slim',
        cpus: 2,
        memory_mib: 512,
        disk_size_gb: 10,
        working_dir: '/app',
        env: { DEBUG: '1' },
        entrypoint: ['python'],
        cmd: ['-c', 'print(1)'],
        user: '1000:1000',
        // What the Rust core actually sends when the caller did not pass -d.
        detach: false,
        auto_stop: 900,
        auto_delete: 0,
        auto_resume: true,
        network: { outbound: { mode: 'enabled', allow_net: ['api.openai.com'] }, inbound: { mode: 'disabled' } },
        volumes: [{ managed_volume: 'vol_01K2EXAMPLE', guest_path: '/data' }],
      },
      meta,
    )

    expect(dto.image).toBe('python:3.11-slim')
    expect(dto.network?.outbound?.allow_net).toEqual(['api.openai.com'])
    expect(dto.volumes?.[0]?.guest_path).toBe('/data')
  })

  // Already-deployed callers send the pre-split flat network shape. Whitelisting
  // must not turn that into a 400 — `normalizeNetworkShape` rewrites it to the
  // nested form before validation sees it.
  it('still accepts the deprecated flat network shape', async () => {
    const dto: CreateBoxDto = await pipe!.transform(
      { image: 'alpine:latest', network: { mode: 'enabled', allow_net: ['api.openai.com'] } },
      meta,
    )

    expect(dto.network?.outbound?.mode).toBe('enabled')
  })

  // #1350 dropped the `volume://` scheme and the `host_path` alias for a typed
  // `managed_volume` the server resolves as either an id or a name. Both forms
  // must survive the whitelist.
  it.each([
    ['an id', 'vol_01K2EXAMPLE'],
    ['a name', 'my-volume'],
  ])('accepts a managed volume addressed by %s', async (_label, selector) => {
    const dto: CreateBoxDto = await pipe!.transform(
      { image: 'alpine:latest', volumes: [{ managed_volume: selector, guest_path: '/data' }] },
      meta,
    )

    expect(dto.volumes?.[0]?.managed_volume).toBe(selector)
  })
})

// Making a box public exposes its services to anyone, so this route must ask
// for the same permission as the dashboard's toggle. Read off the real
// handler, as the pipe above is, so deleting the decorator fails here.
describe('BoxliteBoxController permissions', () => {
  it('requires WRITE_BOXES to change inbound access', () => {
    const required = new Reflector().get(
      RequiredOrganizationResourcePermissions,
      BoxliteBoxController.prototype.updateInboundNetwork,
    )

    expect(required).toEqual([OrganizationResourcePermission.WRITE_BOXES])
  })
})

// GHSA-2qqv-7cwv-mj8h / POL-845: attaching a managed volume is authorized on
// the caller's volume permissions, independently of WRITE_BOXES. A box-capable
// key must not reach a volume through box creation.
describe('BoxliteBoxController volume attachment authorization', () => {
  const { READ_VOLUMES, WRITE_VOLUMES, WRITE_BOXES } = OrganizationResourcePermission

  function makeController() {
    const boxService = {
      create: jest.fn().mockResolvedValue({ id: 'box-1', state: 'started' }),
      toBoxDto: jest.fn(),
    }
    const boxStateWaiter = { waitForStarted: jest.fn() }
    const commerceBoxLimitService = { resolveMaxCreatedBoxes: jest.fn().mockResolvedValue(10) }
    const controller = new BoxliteBoxController(
      boxService as any,
      boxStateWaiter as any,
      commerceBoxLimitService as any,
    )
    return { controller, boxService }
  }

  function keyContext(permissions: OrganizationResourcePermission[]) {
    return {
      role: 'user',
      organization: { id: 'org-1' },
      organizationId: 'org-1',
      // Owner on purpose: a key is bounded by its own permissions, not widened
      // by whoever owns it.
      organizationUser: { role: 'owner', assignedRoles: [] },
      apiKey: { permissions },
    } as any
  }

  // A non-owner member with no API key is caught by neither bypass, so it is
  // bounded by the permissions its assigned roles carry, resolved exactly as the
  // guard resolves them (assignedRoles.flatMap, a missing list treated as none).
  function memberContext(assignedRoles: Array<{ permissions: OrganizationResourcePermission[] }> | undefined) {
    return {
      role: 'user',
      organization: { id: 'org-1' },
      organizationId: 'org-1',
      organizationUser: { role: 'member', assignedRoles },
    } as any
  }

  const dtoWithVolume = { image: 'alpine:latest', volumes: [{ managed_volume: 'vol_1', guest_path: '/data' }] } as any

  it('refuses a WRITE_BOXES-only key that attaches a volume', async () => {
    const { controller, boxService } = makeController()

    await expect(controller.createBox(keyContext([WRITE_BOXES]), dtoWithVolume)).rejects.toThrow(/managed volume/)
    expect(boxService.create).not.toHaveBeenCalled()
  })

  it('refuses a key holding only one of the two volume permissions', async () => {
    const { controller, boxService } = makeController()

    await expect(controller.createBox(keyContext([WRITE_BOXES, READ_VOLUMES]), dtoWithVolume)).rejects.toThrow(
      /write:volumes/,
    )
    expect(boxService.create).not.toHaveBeenCalled()
  })

  it('allows a key holding both volume permissions', async () => {
    const { controller, boxService } = makeController()

    await controller.createBox(keyContext([WRITE_BOXES, READ_VOLUMES, WRITE_VOLUMES]), dtoWithVolume)

    expect(boxService.create).toHaveBeenCalledTimes(1)
  })

  it('does not gate a volume-free create on volume permissions', async () => {
    const { controller, boxService } = makeController()

    await controller.createBox(keyContext([WRITE_BOXES]), { image: 'alpine:latest' } as any)

    expect(boxService.create).toHaveBeenCalledTimes(1)
  })

  it('exempts a system admin and an interactive owner without a key', async () => {
    const { controller, boxService } = makeController()
    const admin = { role: 'admin', organization: { id: 'org-1' }, organizationId: 'org-1' } as any
    const owner = {
      role: 'user',
      organization: { id: 'org-1' },
      organizationId: 'org-1',
      organizationUser: { role: 'owner', assignedRoles: [] },
    } as any

    await controller.createBox(admin, dtoWithVolume)
    await controller.createBox(owner, dtoWithVolume)

    expect(boxService.create).toHaveBeenCalledTimes(2)
  })

  it('allows a member whose assigned roles grant both volume permissions', async () => {
    const { controller, boxService } = makeController()

    await controller.createBox(memberContext([{ permissions: [READ_VOLUMES, WRITE_VOLUMES] }]), dtoWithVolume)

    expect(boxService.create).toHaveBeenCalledTimes(1)
  })

  it('refuses a member whose assigned roles lack the volume permissions', async () => {
    const { controller, boxService } = makeController()

    await expect(
      controller.createBox(memberContext([{ permissions: [WRITE_BOXES] }]), dtoWithVolume),
    ).rejects.toThrow(/managed volume/)
    expect(boxService.create).not.toHaveBeenCalled()
  })

  it('refuses a member that carries no assigned roles', async () => {
    const { controller, boxService } = makeController()

    await expect(controller.createBox(memberContext(undefined), dtoWithVolume)).rejects.toThrow(/managed volume/)
    expect(boxService.create).not.toHaveBeenCalled()
  })
})

// The audit log for a visibility change must name the box and the mode asked
// for, and nothing else from the body. Driven through the real interceptor
// with the handler's own @Audit metadata, so a wrong extractor fails here.
describe('BoxliteBoxController inbound audit', () => {
  it('records the box and the requested mode', async () => {
    const auditService = {
      createLog: jest.fn().mockResolvedValue({ id: 'audit-1' }),
      updateLog: jest.fn().mockResolvedValue({ id: 'audit-1' }),
    }
    const interceptor = new AuditInterceptor(new Reflector(), auditService as any, { get: jest.fn() } as any)
    const request = {
      url: '/api/v1/boxes/box-1/network/inbound',
      ip: '127.0.0.1',
      params: { boxId: 'box-1' },
      body: { mode: 'enabled', allow_net: [] },
      user: { userId: 'user-1', email: 'dev@example.com', organizationId: 'org-1' },
      get: jest.fn(),
    }
    const context = {
      getHandler: () => BoxliteBoxController.prototype.updateInboundNetwork,
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ statusCode: 200 }) }),
    } as unknown as ExecutionContext
    const next: CallHandler = { handle: () => of({ mode: 'enabled' }) }

    await firstValueFrom(interceptor.intercept(context, next))

    expect(auditService.createLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.UPDATE_PUBLIC_STATUS,
        targetType: AuditTarget.BOX,
        targetId: 'box-1',
        metadata: { body: { mode: 'enabled' } },
      }),
    )
  })
})
