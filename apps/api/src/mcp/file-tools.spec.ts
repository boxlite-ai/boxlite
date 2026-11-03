/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Header } from 'tar'
import { gzipSync } from 'node:zlib'
import { McpFileTools } from './file-tools'
import { archiveTextFile, TEXT_FILE_LIMIT } from './file-content'
import { RUNNER_ARCHIVE_LIMIT } from './runner-http'
import { runnerHarness, caller, ORGANIZATION_ID, FOREIGN_ORGANIZATION_ID } from './tests/runner-harness'

function fixtureTar(
  entries: { type?: 'File' | 'Directory' | 'SymbolicLink'; content?: Buffer; path?: string }[],
): Buffer {
  const blocks: Buffer[] = []
  for (const entry of entries) {
    const content = entry.content ?? Buffer.alloc(0)
    const block = Buffer.alloc(512)
    new Header({
      path: entry.path ?? 'file',
      type: entry.type ?? 'File',
      linkpath: entry.type === 'SymbolicLink' ? 'target' : undefined,
      size: content.length,
      mode: 0o644,
    }).encode(block)
    blocks.push(block, content, Buffer.alloc((512 - (content.length % 512)) % 512))
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)])
}

describe('McpFileTools HTTP tar boundary', () => {
  let harness: Awaited<ReturnType<typeof runnerHarness>>
  let fixture: ReturnType<typeof harness.reset>
  const scope = { organization_id: ORGANIZATION_ID, box_id: 'my box', path: '/tmp/hello.txt' }
  beforeAll(async () => {
    harness = await runnerHarness((server, access, runner) => new McpFileTools(access, runner).register(server, caller))
  })
  afterAll(async () => harness.close())
  beforeEach(() => {
    fixture = harness.reset()
  })

  function download(archive: Buffer, sourceIsDirectory?: boolean) {
    harness.respond((response) => {
      if (sourceIsDirectory !== undefined) response.setHeader('x-boxlite-source-is-dir', String(sourceIsDirectory))
      response.setHeader('content-type', 'application/x-tar')
      response.end(archive)
    })
  }

  it.each(['hello 世界\n', '', '\ufeffhello'])(
    'round-trips UTF-8 content %j across actual HTTP and standard tar headers',
    async (content) => {
      let uploaded: Buffer
      harness.respond((response, body) => {
        uploaded = body
        response.writeHead(204)
        response.end()
      })
      const upload = await harness.call('upload_files', { ...scope, file: { format: 'utf8', content } })
      expect(upload.result.structuredContent).toEqual({ completed: true })
      const header = new Header(uploaded)
      expect(header.cksumValid).toBe(true)
      expect(header.path).toBe('hello.txt')
      expect(header.type).toBe('File')
      expect(header.size).toBe(Buffer.byteLength(content))
      expect(uploaded.subarray(512, 512 + header.size)).toEqual(Buffer.from(content))
      expect(harness.requests[0].authorization).toBe('Bearer runner-secret')
      const url = new URL(harness.requests[0].url, 'http://runner.test')
      expect(url.searchParams.get('path')).toBe(scope.path)
      expect(url.searchParams.get('source_is_dir')).toBe('false')
      download(uploaded, false)
      const result = await harness.call('download_files', scope)
      expect(result.result.structuredContent).toEqual({ file: { format: 'utf8', content, source_is_directory: false } })
      expect(JSON.parse(result.result.content[0].text)).toEqual(result.result.structuredContent)
    },
  )

  it('uses installed PAX support for Unicode and long guest basenames', async () => {
    const path = `/tmp/${'长'.repeat(60)}.txt`
    const archive = archiveTextFile(path, 'hello 世界')
    download(archive, false)
    expect((await harness.call('download_files', { ...scope, path })).result.structuredContent.file.content).toBe(
      'hello 世界',
    )
  })

  it('preserves binary directory tar bytes and directory source hints', async () => {
    const archive = fixtureTar([
      { type: 'Directory', path: 'dir/' },
      { path: 'dir/file', content: Buffer.from([0, 255, 1]) },
    ])
    harness.respond((response) => {
      response.writeHead(204)
      response.end()
    })
    const upload = await harness.call('upload_files', {
      ...scope,
      path: '/tmp/dir',
      file: { format: 'tar_base64', archive_base64: archive.toString('base64'), source_is_directory: true },
    })
    expect(upload.result.structuredContent).toEqual({ completed: true })
    expect(harness.requests[0].body).toEqual(archive)
    expect(new URL(harness.requests[0].url, 'http://runner.test').searchParams.get('source_is_dir')).toBe('true')
    download(archive, true)
    const result = await harness.call('download_files', { ...scope, path: '/tmp/dir/.', format: 'tar_base64' })
    expect(result.result.structuredContent).toEqual({
      file: { format: 'tar_base64', archive_base64: archive.toString('base64'), source_is_directory: true },
    })
    expect(new URL(harness.requests[1].url, 'http://runner.test').searchParams.get('path')).toBe('/tmp/dir/.')
  })

  it('represents absent source-kind metadata as unknown and refuses to infer a text source', async () => {
    const archive = archiveTextFile(scope.path, 'hello')
    download(archive)
    const text = await harness.call('download_files', scope)
    expect(text.result.isError).toBe(true)
    expect(text.result.content[0].text).toContain('unknown source shape')
    const binary = await harness.call('download_files', { ...scope, format: 'tar_base64' })
    expect(binary.result.structuredContent.file.source_is_directory).toBeNull()
    expect(binary.result.structuredContent.file.archive_base64).toBe(archive.toString('base64'))
  })

  it.each([
    ['directory', fixtureTar([{ type: 'Directory' }])],
    ['symbolic link', fixtureTar([{ type: 'SymbolicLink' }])],
    ['multiple files', fixtureTar([{ content: Buffer.from('one') }, { path: 'two', content: Buffer.from('two') }])],
    ['invalid UTF-8', fixtureTar([{ content: Buffer.from([255]) }])],
    ['binary controls', fixtureTar([{ content: Buffer.from([0, 1, 2]) }])],
    ['truncated tar', archiveTextFile('/tmp/file', 'hello').subarray(0, 1024)],
    ['malformed tar', Buffer.alloc(512, 1)],
    ['compressed tar', gzipSync(archiveTextFile('/tmp/file', 'hello'))],
    ['oversized text', fixtureTar([{ content: Buffer.alloc(TEXT_FILE_LIMIT + 1, 65) }])],
  ])('rejects unsupported %s text results', async (_name, archive) => {
    download(archive, false)
    const result = await harness.call('download_files', scope)
    expect(result.result.isError).toBe(true)
    expect(result.result).not.toHaveProperty('structuredContent')
  })

  it('refuses directory source metadata even when its archive happens to contain one regular file', async () => {
    download(archiveTextFile('/tmp/file', 'hello'), true)
    expect((await harness.call('download_files', scope)).result.isError).toBe(true)
  })

  it('accepts the 60 KiB UTF-8 byte boundary and rejects multibyte overflow before dispatch', async () => {
    harness.respond((response) => {
      response.writeHead(204)
      response.end()
    })
    const content = 'é'.repeat(TEXT_FILE_LIMIT / 2)
    expect(
      (await harness.call('upload_files', { ...scope, file: { format: 'utf8', content } })).result.isError,
    ).toBeFalsy()
    expect(harness.requests[0].body.length).toBeLessThanOrEqual(RUNNER_ARCHIVE_LIMIT)
    const tooLarge = await harness.call('upload_files', { ...scope, file: { format: 'utf8', content: `${content}é` } })
    expect(tooLarge.result.isError).toBe(true)
    expect(harness.requests).toHaveLength(1)
  })

  it.each(['A===', 'Zh==', 'Zg==\n', '', Buffer.alloc(RUNNER_ARCHIVE_LIMIT + 1).toString('base64')])(
    'rejects invalid or oversized decoded base64 before Runner dispatch',
    async (archive_base64) => {
      const result = await harness.call('upload_files', { ...scope, file: { format: 'tar_base64', archive_base64 } })
      expect(result.error ?? result.result.isError).toBeTruthy()
      expect(harness.requests).toHaveLength(0)
    },
  )

  it.each([{ overwrite: false }, { follow_symlinks: true }])(
    'rejects unsupported hosted transfer controls %j',
    async (unsupported) => {
      const result = await harness.call('upload_files', {
        ...scope,
        file: { format: 'utf8', content: 'hello' },
        ...unsupported,
      })
      expect(result.error ?? result.result.isError).toBeTruthy()
      expect(fixture.memberships.findOne).not.toHaveBeenCalled()
      expect(harness.requests).toHaveLength(0)
    },
  )

  it('requires WRITE_BOXES for downloads and denies foreign organization or Box access before network', async () => {
    fixture.member.assignedRoles = []
    expect((await harness.call('download_files', scope)).result.isError).toBe(true)
    fixture = harness.reset()
    fixture.memberships.findOne.mockResolvedValueOnce(null)
    expect(
      (await harness.call('download_files', { ...scope, organization_id: FOREIGN_ORGANIZATION_ID })).result.isError,
    ).toBe(true)
    fixture.box.organizationId = FOREIGN_ORGANIZATION_ID
    expect((await harness.call('download_files', scope)).result.isError).toBe(true)
    expect(harness.requests).toHaveLength(0)
  })
})
