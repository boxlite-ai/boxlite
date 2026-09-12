/*
 * A group whose declaration has an optional half, read by every command.
 *
 * The point of the optional half is that a stage which never configured a
 * feature still has a complete group. Teaching only `selectGroup` — the
 * programmatic read a deploy makes — left the three commands demanding every
 * name, so such a stage could not be listed, fingerprinted, or checked. All
 * three refused by naming as missing the keys the file had just allowed to be.
 */

import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import test from 'node:test'
import { digest as digestCommand, list, set } from '../src/cli/handlers/env.ts'

const KEY = randomBytes(32)

const sealed = (value: unknown): Buffer => {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', KEY, nonce)
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return Buffer.concat([nonce, body, cipher.getAuthTag()])
}

const opened = (payload: Buffer): Record<string, string> => {
  const nonce = payload.subarray(0, 12)
  const decipher = createDecipheriv('aes-256-gcm', KEY, nonce)
  decipher.setAuthTag(payload.subarray(payload.length - 16))
  const body = payload.subarray(12, payload.length - 16)
  return JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8'))
}

const notFound = (name: string) => Object.assign(new Error(name), { name })

/**
 * Two required names, two optional ones and a digest — against a store holding
 * only the required half, which is a stage that configured nothing optional.
 */
const CONFIG = {
  path: '/repo/.mstage.config.json',
  envSelectGroup: { deploy: ['DOMAIN', 'ZONE', 'MAIL_RELAY_HOST', 'POSTHOG_HOST', 'DIGEST'] },
  envOptional: { deploy: ['MAIL_RELAY_HOST', 'POSTHOG_HOST'] },
  envDigest: { key: 'DIGEST', group: 'deploy' },
}

const harness = (stored: Record<string, string>) => {
  const puts: any[] = []
  const store: Record<string, Buffer> = { 'secret/a/dev.json': sealed(stored) }
  const lines: string[] = []
  const backend = {
    s3: {
      send: async (command: any) => {
        if (command.input.Body) {
          puts.push(command.input)
          return {}
        }
        const object = store[command.input.Key]
        if (!object) throw notFound('NoSuchKey')
        return { Body: { transformToByteArray: async () => object } }
      },
    },
    ssm: {
      send: async (command: any) =>
        command.input.Name === '/sst/bootstrap'
          ? { Parameter: { Value: JSON.stringify({ state: 'sst-state-x' }) } }
          : { Parameter: { Value: KEY.toString('base64') } },
    },
  } as any
  const scope = { app: 'a', stage: 'dev', protect: false } as any
  const log = (line: string) => lines.push(line)
  return {
    lines,
    written: () => (puts.length > 0 ? opened(puts[puts.length - 1].Body) : null),
    setDigest: () =>
      set({
        config: CONFIG as any,
        scope,
        positionals: [],
        options: { digest: true },
        log,
        backend,
        readInput: async () => {
          throw new Error('stdin must not be read')
        },
        readBatch: async () => '',
      }),
    checkDigest: () => digestCommand({ config: CONFIG as any, scope, log, backend }),
    listGroup: () =>
      list({ config: CONFIG as any, scope, options: { 'select-group': 'deploy' }, log, backend }),
  }
}

const CONFIGURED = { DOMAIN: 'dev.boxlite.ai', ZONE: 'c65b', DIGEST: 'stale' }

test('a fingerprint can be written for a stage that configured no optional feature', async () => {
  // What a new stage hits on its first write: the store holds every required
  // name, and the command refuses it over the optional ones.
  const probe = harness(CONFIGURED)
  assert.equal(await probe.setDigest(), 0, probe.lines.join('\n'))
  const written = probe.written()
  assert.ok(written, 'nothing was written')
  assert.notEqual(written.DIGEST, 'stale', 'the fingerprint was not recomputed')
})

test('and the check agrees with the write, over the same set', async () => {
  // These must compute over identical sets. A check demanding more than the
  // write can supply reports every stage as broken, and is believed.
  const probe = harness(CONFIGURED)
  await probe.setDigest()
  const fingerprint = probe.written()!.DIGEST as string

  const checked = harness({ ...CONFIGURED, DIGEST: fingerprint })
  assert.equal(await checked.checkDigest(), 0, checked.lines.join('\n'))
  assert.match(checked.lines.join('\n'), new RegExp(`got: *${fingerprint}`))
})

test('an optional name that is present still moves the fingerprint', async () => {
  // Optional means the store need not hold it, not that its value is ignored:
  // a relay host nobody notices changing is a stage silently sending elsewhere.
  const without = harness(CONFIGURED)
  await without.setDigest()
  const withRelay = harness({ ...CONFIGURED, MAIL_RELAY_HOST: 'smtp.example.com' })
  await withRelay.setDigest()
  assert.notEqual(without.written()!.DIGEST, withRelay.written()!.DIGEST)
})

test('listing a group does not demand what the declaration called optional', async () => {
  const probe = harness(CONFIGURED)
  assert.equal(await probe.listGroup(), 0, probe.lines.join('\n'))
  const printed = probe.lines.join('\n')
  assert.match(printed, /DOMAIN/)
  assert.match(printed, /ZONE/)
})

test('a required name that is genuinely missing is still refused', async () => {
  // The other half: accepting every absence would remove the one failure this
  // mechanism exists to produce.
  const probe = harness({ DOMAIN: 'dev.boxlite.ai', DIGEST: 'stale' })
  await assert.rejects(() => probe.setDigest(), /ZONE/)
})
