// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  Auth0CliManagementClient,
  Auth0LoginPolicyConfigurator,
  missingLoginPolicyScopes,
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
    // Checked here rather than in the configurator: the session belongs to the
    // CLI client this entrypoint chose. Apply only — preview writes nothing, so
    // a scope it lacks costs a failed read, not a half-applied tenant.
    if (options.apply) {
      const missing = missingLoginPolicyScopes(options.tenant)
      if (missing.length > 0) {
        throw new Error(
          `the auth0 CLI session for ${options.tenant} lacks ${missing.length} scope(s) apply writes with ` +
            `(${missing.join(',')}); run \`npm run auth0:login-policy-login\` and select that tenant`,
        )
      }
    }
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
