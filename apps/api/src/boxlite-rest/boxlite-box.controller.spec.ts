/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import 'reflect-metadata'
import { BadRequestException, ValidationPipe } from '@nestjs/common'
import { PIPES_METADATA } from '@nestjs/common/constants'
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
    ['secrets', { secrets: [{ name: 'openai', value: 'sk-real', placeholder: '<X>' }] }, 'not supported for cloud'],
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
