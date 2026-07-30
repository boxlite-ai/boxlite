// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { parse } from 'dotenv'

const FORBIDDEN_DEPLOYMENT_KEYS = new Set([
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
  'BUILDX_BUILDER',
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
