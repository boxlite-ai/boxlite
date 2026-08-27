// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  Auth0CliManagementClient,
  Auth0LoginPolicyConfigurator,
  parseAuth0LoginPolicyOptions,
} from './auth0-login-policy.js'

const bootstrapRoot = dirname(fileURLToPath(import.meta.url))

function sources() {
  return {
    actionCode: readFileSync(join(bootstrapRoot, 'auth0', 'login-policy.js'), 'utf8'),
    emailVerificationTemplate: JSON.parse(
      readFileSync(join(bootstrapRoot, 'auth0', 'email-verification-form.json'), 'utf8'),
    ),
    journalDirectory: join(bootstrapRoot, '..', '.sst', 'auth0-backups'),
  }
}

try {
  if (process.argv[2] === '--rollback') {
    const journalPath = process.argv[3]
    if (!journalPath || process.argv.length !== 4) {
      throw new Error('usage: npm run auth0:configure-login -- --rollback <journal-path>')
    }
    console.log(
      JSON.stringify(
        Auth0LoginPolicyConfigurator.rollback(journalPath, (tenant) => new Auth0CliManagementClient(tenant)),
        null,
        2,
      ),
    )
  } else {
    const options = parseAuth0LoginPolicyOptions(process.argv.slice(2))
    const configurator = new Auth0LoginPolicyConfigurator(
      options,
      new Auth0CliManagementClient(options.tenant),
      sources(),
    )
    console.log(JSON.stringify(options.apply ? configurator.apply() : configurator.preview(), null, 2))
  }
} catch (error: any) {
  console.error(`[auth0-configure-login] ${error.message}`)
  let cause = error.cause
  while (cause) {
    console.error(`[auth0-configure-login] caused by: ${cause.message ?? String(cause)}`)
    cause = cause.cause
  }
  process.exitCode = 1
}
