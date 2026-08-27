// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'

import { Auth0ManagementCli } from './management-cli.js'
import {
  FileBrandingSource,
  HttpBrandingVerifier,
  PartialApplyError,
  UniversalLoginBranding,
  type BrandingChange,
  type JsonObject,
  type JsonValue,
  type PreparedBranding,
} from './universal-login.js'

type UniversalLoginAction = 'preview' | 'apply' | 'help'

export interface UniversalLoginOptions {
  action: UniversalLoginAction
  stage: string
  yes: boolean
}

interface CommandDependencies {
  branding: UniversalLoginBranding
  input?: NodeJS.ReadableStream
  output?: NodeJS.WritableStream
  isTty?: boolean
}

export function parseUniversalLoginArgs(args: readonly string[]): UniversalLoginOptions {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    return { action: 'help', stage: '', yes: false }
  }
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      stage: { type: 'string' },
      yes: { type: 'boolean', default: false },
    },
  })
  const action = positionals[0]
  if ((action !== 'preview' && action !== 'apply') || positionals.length !== 1) {
    throw new Error('action must be preview or apply')
  }
  const stage = values.stage?.trim()
  if (!stage) throw new Error('--stage is required')
  if (action === 'preview' && values.yes) throw new Error('--yes is valid only with apply')
  return { action, stage, yes: values.yes ?? false }
}

function flatten(value: JsonValue | undefined, prefix = ''): Map<string, JsonValue> {
  const result = new Map<string, JsonValue>()
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of Object.keys(value).sort()) {
      const path = prefix ? `${prefix}.${key}` : key
      for (const [nestedPath, nestedValue] of flatten((value as JsonObject)[key], path)) {
        result.set(nestedPath, nestedValue)
      }
    }
    return result
  }
  result.set(prefix, value ?? null)
  return result
}

function renderChange(change: BrandingChange) {
  const before = change.before === null ? new Map<string, JsonValue>() : flatten(change.before)
  const after = flatten(change.after)
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort()
  const lines = [`${change.kind === 'theme' && change.action === 'create' ? '+' : '~'} ${change.resource}`]
  for (const path of paths) {
    const hadBefore = before.has(path)
    const hasAfter = after.has(path)
    const oldValue = before.get(path)
    const newValue = after.get(path)
    if (hadBefore && hasAfter && JSON.stringify(oldValue) === JSON.stringify(newValue)) continue
    if (!hadBefore) lines.push(`    + ${path} = ${JSON.stringify(newValue)}`)
    else if (!hasAfter) lines.push(`    - ${path} = ${JSON.stringify(oldValue)}`)
    else lines.push(`    ~ ${path}: ${JSON.stringify(oldValue)} -> ${JSON.stringify(newValue)}`)
  }
  return lines
}

export function renderPreview(prepared: PreparedBranding) {
  const lines = [
    'Auth0 Universal Login preview',
    '',
    `Stage:  ${prepared.target.stage}`,
    `Stack:  ${prepared.target.stackOrigin}`,
    `Issuer: ${prepared.target.publicOidcIssuer}`,
    `Tenant: ${prepared.target.auth0TenantDomain}`,
    '',
    'Checks',
    ...prepared.checks.map((check) => `✓ ${check}`),
    '',
    'Changes',
  ]
  if (prepared.changes.length === 0) lines.push('No changes.')
  else for (const change of prepared.changes) lines.push(...renderChange(change), '')
  lines.push(
    prepared.changes.length === 0
      ? 'Auth0 Universal Login is already up to date.'
      : `${prepared.changes.length} resource(s) would change.`,
  )
  return `${lines.join('\n')}\n`
}

async function confirmStage(
  stage: string,
  tenant: string,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  signal?: AbortSignal,
) {
  const readline = createInterface({ input, output })
  try {
    return (await readline.question(`Type "${stage}" to apply to ${tenant}: `, { signal })).trim() === stage
  } finally {
    readline.close()
  }
}

export async function runUniversalLoginCommand(
  args: readonly string[],
  {
    branding,
    input = process.stdin,
    output = process.stdout,
    isTty = Boolean(process.stdin.isTTY),
  }: CommandDependencies,
  signal?: AbortSignal,
) {
  const options = parseUniversalLoginArgs(args)
  if (options.action === 'help') {
    output.write(
      'Usage: npm run auth0:universal-login -- <preview|apply> --stage <name> [--yes]\n' +
        '\n' +
        '  preview  Validate the selected target and show Auth0 changes.\n' +
        '  apply    Preview, confirm the exact target, then apply and verify changes.\n' +
        '  --yes    Skip the interactive apply confirmation.\n',
    )
    return
  }
  const prepared = await branding.prepare(options.stage, signal)
  output.write(renderPreview(prepared))
  if (options.action === 'preview') {
    output.write('No changes were applied.\n')
    return
  }
  if (prepared.changes.length === 0) return
  if (!options.yes) {
    if (!isTty) throw new Error('apply requires an interactive terminal or --yes')
    if (!(await confirmStage(prepared.target.stage, prepared.target.auth0TenantDomain, input, output, signal))) {
      throw new Error('apply cancelled: confirmation did not match the target stage')
    }
  }
  const report = await branding.apply(prepared, signal)
  output.write(`Applied ${report.applied.length} Auth0 Universal Login resource(s).\n`)
}

function formatError(cause: unknown) {
  if (cause instanceof PartialApplyError) {
    return [
      cause.message,
      `applied: ${cause.applied.join(', ') || '<none>'}`,
      `unknown: ${cause.unknown.join(', ') || '<none>'}`,
      `pending: ${cause.pending.join(', ') || '<none>'}`,
    ].join('\n')
  }
  return cause instanceof Error ? cause.message : String(cause)
}

async function main() {
  const controller = new AbortController()
  const interrupt = () => controller.abort(new Error('interrupted by SIGINT'))
  process.once('SIGINT', interrupt)
  try {
    const branding = new UniversalLoginBranding({
      source: new FileBrandingSource(),
      verifier: new HttpBrandingVerifier(),
      gateway: new Auth0ManagementCli(),
    })
    await runUniversalLoginCommand(process.argv.slice(2), { branding }, controller.signal)
  } catch (cause) {
    process.stderr.write(`${formatError(cause)}\n`)
    process.exitCode = controller.signal.aborted ? 130 : 1
  } finally {
    process.removeListener('SIGINT', interrupt)
  }
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? '')) await main()
