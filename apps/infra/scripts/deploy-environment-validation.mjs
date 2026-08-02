// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { parse } from 'dotenv'

const FORBIDDEN_DEPLOYMENT_KEYS = new Set([
  'ALLOW_DOWNGRADE',
  'API_ARTIFACT_SOURCE',
  'AWS_ACCESS_KEY_ID',
  'AWS_CLI_PATH',
  'AWS_CONFIG_FILE',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_DEFAULT_PROFILE',
  'AWS_ENDPOINT_URL',
  'AWS_PROFILE',
  'AWS_ROLE_ARN',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_SESSION_TOKEN',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  // The workflow picks which artifact a deploy installs, and CI has already staged or published
  // exactly that one. A stage secret redirecting the selector — or quietly re-enabling the
  // downgrade escape hatch the dispatcher left off — would deploy something the run never
  // approved. (VERSION stays allowed: it is the documented local knob, and the workflow's own
  // value already wins over .env.)
  'BOXLITE_ARTIFACT_REF',
  'BOXLITE_ARTIFACT_SOURCE',
  'BUILDX_BUILDER',
  // Listed for the same defense-in-depth reason as the AWS keys above, which the workflow also
  // already sets: every current consumer assigns this after spreading process.env, so a stage
  // secret cannot win today. It earns its place because of what it would buy if one ever stopped
  // — requireBuildLocation derives the tarball URL *and* its checksum URL from this single value,
  // so redirecting it verifies an attacker-chosen artifact against an attacker-chosen manifest.
  'RUNNER_ARTIFACT_BUCKET',
  'RUNNER_ARTIFACT_SOURCE',
  'RUNNER_CREATE_ALLOWLIST',
  'SST_BIN_PATH',
])

export function validateDeployEnvironment(source) {
  for (const [index, rawLine] of source.split(/\r?\n/).entries()) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(line)) {
      throw new Error(`DEPLOY_ENV contains invalid assignment syntax on line ${index + 1}; expected KEY=value`)
    }
  }

  const configuredKeys = Object.keys(parse(source))
  const forbiddenKeys = configuredKeys
    .filter((key) => FORBIDDEN_DEPLOYMENT_KEYS.has(key) || key.startsWith('AWS_ENDPOINT_URL_'))
    .sort()
  if (forbiddenKeys.length > 0) {
    throw new Error(
      `DEPLOY_ENV must rely on workflow OIDC and the native CI builder, and must not define: ${forbiddenKeys.join(', ')}`,
    )
  }
}

async function main(args) {
  if (args.length !== 1) throw new Error('expected exactly one DEPLOY_ENV file path')
  validateDeployEnvironment(await readFile(args[0], 'utf8'))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`deploy-environment-validation: ${error.message}`)
    process.exitCode = 1
  })
}
