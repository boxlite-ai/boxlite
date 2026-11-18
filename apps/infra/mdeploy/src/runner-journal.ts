// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunCommand } from './upgrade-runners.ts'

export const isSsmCommandId = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)

export type JournalScope = { app: string; stage: string; bucket: string }
type Status = 'submitting' | 'submitted' | 'succeeded' | 'failed' | 'superseded'
type Entry = {
  operationId: string
  digest: string
  identity: string
  status: Status
  commandId?: string
  updatedAt?: string
  reason?: string
  actor?: string
}
type Revision = { etag: string; entry: Entry }
export const outstanding = (record: Revision | null): record is Revision =>
  record?.entry.status === 'submitting' || record?.entry.status === 'submitted'

/** One object per EC2 instance. All writers, including recovery, compare the exact revision they read. */
export const runnerJournal = (scope: JournalScope, region: string, target: string, run: RunCommand) => {
  if (
    ![scope.app, scope.stage].every(
      (part) => typeof part === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/.test(part),
    ) ||
    typeof region !== 'string' ||
    !/^[a-z0-9][a-z0-9-]*$/.test(region) ||
    typeof scope.bucket !== 'string' ||
    !/^i-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(target) ||
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(scope.bucket)
  )
    throw new Error('A Runner rollout needs a valid app, stage, region, state bucket and exact EC2 instance ID')
  const key = ['rollouts/aws', scope.app, scope.stage, region, target + '.json'].join('/')
  const address = ['--region', region, '--bucket', scope.bucket, '--key', key, '--output', 'json']
  const local = <T>(use: (file: string) => T): T => {
    const dir = mkdtempSync(join(tmpdir(), 'boxlite-rollout-'))
    try {
      return use(join(dir, 'record.json'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  const etagOf = (output: string): string => {
    const { ETag } = JSON.parse(output)
    if (typeof ETag !== 'string' || !ETag.length) throw new Error('S3 returned no rollout ETag for ' + key)
    return ETag
  }
  const read = (): Revision | null =>
    local((file) => {
      const result = run('aws', ['s3api', 'get-object', ...address, file])
      if (!result.ok) {
        if (/\(NoSuchKey\)/.test(result.stderr)) return null
        throw new Error('Cannot read Runner operation ' + key + ': ' + result.stderr)
      }
      const entry: Entry = JSON.parse(readFileSync(file, 'utf8'))
      if (
        !entry ||
        typeof entry.operationId !== 'string' ||
        !/^[a-f0-9-]{36}$/.test(entry.operationId) ||
        typeof entry.digest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(entry.digest) ||
        typeof entry.identity !== 'string' ||
        !entry.identity ||
        (entry.commandId !== undefined && !isSsmCommandId(entry.commandId)) ||
        !['submitting', 'submitted', 'succeeded', 'failed', 'superseded'].includes(entry.status) ||
        (entry.status === 'submitted' && !entry.commandId)
      )
        throw new Error('Invalid Runner operation at ' + key)
      return { entry, etag: etagOf(result.stdout) }
    })
  const write = (prior: Revision | null, input: Entry): Revision =>
    local((file) => {
      const entry = { ...input, updatedAt: new Date().toISOString() }
      writeFileSync(file, JSON.stringify(entry), { mode: 0o600 })
      const condition = prior ? ['--if-match', prior.etag] : ['--if-none-match', '*']
      const result = run('aws', ['s3api', 'put-object', ...address, '--body', file, ...condition])
      if (
        !result.ok &&
        /\((PreconditionFailed|ConditionalRequestConflict)\)/.test(result.stderr) &&
        prior &&
        input.commandId &&
        ['submitted', 'succeeded', 'failed'].includes(input.status)
      ) {
        const current = read()
        if (
          current &&
          current.entry.operationId === input.operationId &&
          current.entry.commandId === input.commandId &&
          (current.entry.status === input.status ||
            (input.status === 'submitted' && ['succeeded', 'failed'].includes(current.entry.status)))
        )
          return current
      }
      if (!result.ok)
        throw new Error(
          'Cannot claim or update Runner operation ' + input.operationId + ' at ' + key + ': ' + result.stderr,
        )
      return { entry, etag: etagOf(result.stdout) }
    })
  const release = (operationId: string, reason: string) => {
    if (!reason.trim() || reason.trim().length > 512)
      throw new Error('Force unlock requires a reason of 1–512 characters')
    const record = read()
    if (!outstanding(record) || record.entry.operationId !== operationId)
      throw new Error('Active Runner operation ID does not match; inspect rollout status')
    const who = run('aws', ['sts', 'get-caller-identity', '--region', region, '--query', 'Arn', '--output', 'text'])
    if (!who.ok || !who.stdout.startsWith('arn:'))
      throw new Error('Could not identify the caller for force unlock: ' + who.stderr)
    return write(record, { ...record.entry, status: 'superseded', reason: reason.trim(), actor: who.stdout })
  }
  return { read, write, release }
}
