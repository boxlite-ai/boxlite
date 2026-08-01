// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/*
 * Sign in to every identity provider a deployment needs, in one command.
 *
 * `npm run bootstrap` only ever *verifies* these sessions and fails with a
 * pointer back here, so the check and the fix cannot drift apart. Each
 * provider is a browser sign-in; an already-working session is left alone
 * rather than re-opened.
 *
 * Usage: node scripts/login.mjs [--only aws,github] [--force]
 *   --only   comma-separated subset (aws, github, auth0); default is all
 *   --force  re-authenticate even where a session already works
 *
 * Requires a TTY: every provider here opens a browser and waits for a
 * callback, which cannot complete unattended. CI supplies credentials through
 * OIDC and job env instead, and never runs this.
 */

import { execFileSync, spawnSync } from 'node:child_process'

import { hasFlag, parseFlag } from './cli-flags.mjs'
import { decideLoginAction, selectProviders, summarizeLoginResults } from './login-providers.mjs'

const SCRIPT_NAME = 'login'

function isCliInstalled(command) {
  return spawnSync('command', ['-v', command], { shell: true, stdio: 'ignore' }).status === 0
}

function isAuthenticated(provider) {
  try {
    execFileSync(provider.command, provider.statusArgs, {
      stdio: 'ignore',
      timeout: 30_000,
      killSignal: 'SIGTERM',
    })
    return true
  } catch {
    return false
  }
}

/*
 * stdio is inherited so the CLI can print its verification code, open the
 * browser, and read a confirmation keypress. No timeout: the operator is
 * completing a browser flow at human speed, and killing it mid-redirect would
 * leave a half-finished authorization.
 */
function runLogin(provider) {
  const { status } = spawnSync(provider.command, provider.loginArgs, { stdio: 'inherit' })
  return status === 0
}

function main() {
  const args = process.argv.slice(2)
  const force = hasFlag(args, 'force')
  const only = parseFlag(args, 'only')
  const providers = selectProviders(only ? only.split(',').map((key) => key.trim()).filter(Boolean) : undefined)

  if (!process.stdin.isTTY) {
    throw new Error('a browser sign-in needs a TTY; run this from an interactive shell')
  }

  const results = []
  for (const provider of providers) {
    const cliInstalled = isCliInstalled(provider.command)
    const authenticated = cliInstalled && isAuthenticated(provider)
    const action = decideLoginAction({ cliInstalled, authenticated, force })

    if (action === 'missing-cli') {
      const detail = provider.required ? 'install it, then rerun' : 'only needed for --provision-auth0'
      console.log(`[${SCRIPT_NAME}] ${provider.label} ... \`${provider.command}\` not installed (${detail})`)
      results.push({ ...provider, status: 'missing-cli' })
      continue
    }
    if (action === 'skip') {
      console.log(`[${SCRIPT_NAME}] ${provider.label} ... already signed in (--force to redo)`)
      results.push({ ...provider, status: 'skip' })
      continue
    }

    console.log(`[${SCRIPT_NAME}] ${provider.label} ... opening browser sign-in`)
    const ok = runLogin(provider)
    // Re-probe rather than trusting the exit status: some CLIs exit 0 after a
    // cancelled or partially-completed browser flow.
    const verified = ok && isAuthenticated(provider)
    console.log(`[${SCRIPT_NAME}] ${provider.label} ... ${verified ? 'signed in' : 'FAILED'}`)
    results.push({ ...provider, status: verified ? 'logged-in' : 'failed' })
  }

  const summary = summarizeLoginResults(results)
  for (const label of summary.skippedOptional) {
    console.log(`[${SCRIPT_NAME}] ${label} was skipped; install its CLI if you need it`)
  }
  if (!summary.ok) {
    throw new Error(`sign-in failed for: ${summary.failed.join(', ')}`)
  }
  console.log(`[${SCRIPT_NAME}] done. Next: npm run bootstrap -- --stage <name>`)
}

try {
  main()
} catch (error) {
  console.error(`${SCRIPT_NAME}: ${error.message}`)
  process.exit(1)
}
