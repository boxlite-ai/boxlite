import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import type { RunCommand, CommandResult } from '../src/upgrade-runners.ts'
const ok = (stdout = ''): CommandResult => ({ ok: true, status: 0, stdout, stderr: '' })
const fail = (stderr: string): CommandResult => ({ ok: false, status: 1, stdout: '', stderr })
export const objectStore = () => {
  const objects = new Map<string, { body: string; etag: string }>()
  let revision = 0
  const run: RunCommand = (_, args) => {
    const arg = (flag: string) => args[args.indexOf(flag) + 1]!
    const key = arg('--key')
    const existing = objects.get(key)
    if (args[1] === 'get-object') {
      if (!existing) return fail('(NoSuchKey)')
      writeFileSync(args.at(-1)!, existing.body)
      return ok(JSON.stringify({ ETag: existing.etag }))
    }
    assert.equal(args[1], 'put-object')
    if (existing ? arg('--if-match') !== existing.etag : arg('--if-none-match') !== '*')
      return fail('(PreconditionFailed)')
    const etag = '"revision-' + ++revision + '"'
    objects.set(key, { body: readFileSync(arg('--body'), 'utf8'), etag })
    return ok(JSON.stringify({ ETag: etag }))
  }
  return { objects, run }
}
