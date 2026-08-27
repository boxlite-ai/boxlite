// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Auth0EmailProviderConfigurator, parseAuth0EmailProviderOptions } from './auth0-email-provider.js'
import { Auth0CliManagementClient } from './auth0-login-policy.js'
import { promptSecret, requireNonEmptySecret } from './secret-prompt.js'

const bootstrapRoot = dirname(fileURLToPath(import.meta.url))

function sources() {
  return {
    templates: ['verify-email-by-code.json', 'reset-email-by-code.json'].map((name) =>
      JSON.parse(readFileSync(join(bootstrapRoot, 'auth0', 'email-templates', name), 'utf8')),
    ),
    receiptDirectory: join(bootstrapRoot, '..', '.sst', 'auth0-backups'),
  }
}

async function sesCredentials() {
  return {
    accessKeyId: requireNonEmptySecret(
      'SES access key ID',
      process.env.AUTH0_EMAIL_SES_ACCESS_KEY_ID ?? (await promptSecret('SES access key ID: ')),
    ),
    secretAccessKey: requireNonEmptySecret(
      'SES secret access key',
      process.env.AUTH0_EMAIL_SES_SECRET_ACCESS_KEY ?? (await promptSecret('SES secret access key: ')),
    ),
  }
}

try {
  if (process.argv[2] === '--rollback') {
    const receiptPath = process.argv[3]
    if (!receiptPath || process.argv.length !== 4) {
      throw new Error('usage: npm run auth0:configure-email -- --rollback <receipt-path>')
    }
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
    console.log(
      JSON.stringify(
        Auth0EmailProviderConfigurator.rollback(receiptPath, new Auth0CliManagementClient(receipt.tenant)),
        null,
        2,
      ),
    )
  } else {
    const options = parseAuth0EmailProviderOptions(process.argv.slice(2))
    const configurator = new Auth0EmailProviderConfigurator(
      options,
      new Auth0CliManagementClient(options.tenant),
      sources(),
    )
    console.log(
      JSON.stringify(options.apply ? await configurator.apply(sesCredentials) : configurator.preview(), null, 2),
    )
  }
} catch (error: any) {
  console.error(`[auth0-configure-email] ${error.message}`)
  let cause = error.cause
  while (cause) {
    console.error(`[auth0-configure-email] caused by: ${cause.message ?? String(cause)}`)
    cause = cause.cause
  }
  process.exitCode = 1
}
