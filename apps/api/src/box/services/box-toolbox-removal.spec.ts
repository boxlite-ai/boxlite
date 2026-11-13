// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Box } from '../entities/box.entity'
import { BoxService } from './box.service'

function producer() {
  const service = Object.create(BoxService.prototype) as BoxService
  const regionService = { findOne: jest.fn(), findByIds: jest.fn() }
  const redis = { get: jest.fn(), pipeline: jest.fn() }
  Object.assign(service, {
    regionService,
    redis,
    boxActivityService: { getLastActivityAt: async () => null, getLastActivityAtMany: async () => new Map() },
    boxExitCodeService: { getExitCode: async () => undefined },
    imagePreparationService: { preparingImage: async () => new Set() },
  })
  const box = new Box('us', 'compatibility')
  box.id = 'abc123def456'
  box.organizationId = '057963b2-60ca-4356-81fc-11503e15f249'
  box.osUser = 'boxlite'
  box.labels = {}
  return { service, box, redis, regionService }
}

describe('Toolbox response removal', () => {
  it.each(['single', 'list', 'detail'])('omits the retired field in a %s response without lookups', async (kind) => {
    const { service, box, redis, regionService } = producer()
    const result =
      kind === 'list'
        ? (await service.toBoxDtos([box]))[0]
        : kind === 'detail'
          ? await service.toBoxDtoWithExitCode(box)
          : await service.toBoxDto(box)
    expect(JSON.parse(JSON.stringify(result))).not.toHaveProperty('toolboxProxyUrl')
    expect(redis.get).not.toHaveBeenCalled()
    expect(redis.pipeline).not.toHaveBeenCalled()
    expect(regionService.findOne).not.toHaveBeenCalled()
    expect(regionService.findByIds).not.toHaveBeenCalled()
  })
})

// Supply an exported compatibility-release client to exercise the real decoder without
// depending on Git history or downloading packages during ordinary API tests.
const compatibleClient = process.env.COMPAT_API_CLIENT_ROOT
const clientSuite = compatibleClient ? describe : describe.skip
clientSuite('upgraded Go clients against the current Box producer', () => {
  let temp: string
  const binaries: Record<string, string> = {}
  beforeAll(() => {
    temp = mkdtempSync(join(tmpdir(), 'box-client-compat-'))
    writeFileSync(
      join(temp, 'main.go'),
      `package main
import ("encoding/json"; "fmt"; "os"; client "github.com/boxlite-ai/boxlite/libs/api-client-go")
func main() {
  var boxes []client.Box
  if err := json.NewDecoder(os.Stdin).Decode(&boxes); err != nil { fmt.Fprintln(os.Stderr, err); os.Exit(1) }
  if err := json.NewEncoder(os.Stdout).Encode(boxes); err != nil { panic(err) }
}
`,
    )
    for (const [version, source] of Object.entries({
      compatible: compatibleClient!,
      current: resolve(__dirname, '../../../../libs/api-client-go'),
    })) {
      writeFileSync(
        join(temp, 'go.mod'),
        `module compatibility\ngo 1.23\nrequire github.com/boxlite-ai/boxlite/libs/api-client-go v0.0.0\nreplace github.com/boxlite-ai/boxlite/libs/api-client-go => ${JSON.stringify(resolve(source))}\n`,
      )
      binaries[version] = join(temp, version)
      execFileSync('go', ['build', '-o', binaries[version], '.'], {
        cwd: temp,
        env: { ...process.env, GOWORK: 'off' },
        timeout: 120000,
      })
    }
  }, 240000)
  afterAll(() => {
    if (temp) rmSync(temp, { recursive: true, force: true })
  })

  it.each(['compatible', 'current'])('%s client decodes a nonempty API-produced list', async (version) => {
    const { service, box } = producer()
    const result = spawnSync(binaries[version], [], {
      input: JSON.stringify(await service.toBoxDtos([box])),
      encoding: 'utf8',
    })
    expect({ status: result.status, error: result.stderr }).toEqual({ status: 0, error: '' })
    expect(JSON.parse(result.stdout)[0].id).toBe(box.id)
    expect(JSON.parse(result.stdout)[0]).not.toHaveProperty('toolboxProxyUrl')
  })
})
