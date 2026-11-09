// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadDeploymentEnvironment } from '../deployment/environment.js'
import { Auth0CliManagementClient, assertStageApiAudience } from './auth0-login-policy.js'
import { Auth0McpConfigurator, loadMcpSources, parseAuth0McpOptions } from './auth0-mcp.js'

const bootstrapRoot = dirname(fileURLToPath(import.meta.url))

try {
  if (process.argv[2] === '--rollback') {
    const journalPath = process.argv[3]
    if (!journalPath || process.argv.length !== 4) {
      throw new Error('usage: npm run auth0:configure-mcp -- --rollback <journal-path>')
    }
    const result = Auth0McpConfigurator.rollback(journalPath, (tenant) => new Auth0CliManagementClient(tenant))
    console.log(JSON.stringify(result, null, 2))
  } else {
    const options = parseAuth0McpOptions(process.argv.slice(2))
    // The stage's .env names the audience its API validates; an exported value wins.
    loadDeploymentEnvironment()
    assertStageApiAudience(options.apiAudience)
    const configurator = new Auth0McpConfigurator(options, new Auth0CliManagementClient(options.tenant), {
      ...loadMcpSources(bootstrapRoot),
      journalDirectory: join(bootstrapRoot, '..', '.sst', 'auth0-backups'),
    })
    console.log(JSON.stringify(options.apply ? configurator.apply() : configurator.preview(), null, 2))
  }
} catch (error: any) {
  console.error(`[auth0-configure-mcp] ${error.message}`)
  process.exitCode = 1
}
