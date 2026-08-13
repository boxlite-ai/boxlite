// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/*
 * The identity providers a deployment needs, and how to check and obtain a
 * session for each. `npm run login` walks this list; `npm run bootstrap`
 * only verifies it, so the two cannot disagree about what "logged in" means.
 *
 * Every entry is a browser sign-in: no provider here needs a long-lived key
 * pasted into a terminal. Cloudflare is the exception the deployment still
 * carries — its API token is issued from the dashboard, so it is a secret
 * prompted for during bootstrap rather than a login performed here.
 */

export const LOGIN_PROVIDERS = [
  {
    key: 'aws',
    label: 'AWS',
    command: 'aws',
    // `aws login` (CLI 2.32.0+) exchanges a browser Management Console session
    // for short-lived credentials — no IAM user, no access keys, and no IAM
    // Identity Center setup, which itself takes a separate console visit.
    statusArgs: ['sts', 'get-caller-identity'],
    loginArgs: ['login'],
    required: true,
    // Formula name, not the binary name — `aws` ships as `awscli`.
    install: { manager: 'brew', formula: 'awscli' },
  },
  {
    key: 'github',
    label: 'GitHub',
    command: 'gh',
    statusArgs: ['auth', 'status'],
    loginArgs: ['auth', 'login'],
    required: true,
    install: { manager: 'brew', formula: 'gh' },
  },
  {
    key: 'auth0',
    label: 'Auth0',
    command: 'auth0',
    // Only needed for `bootstrap --provision-auth0`; a deployment whose OIDC
    // provider is already configured never installs this CLI.
    statusArgs: ['tenants', 'list'],
    loginArgs: ['login'],
    required: false,
    install: { manager: 'brew', formula: 'auth0' },
  },
]

export const INSTALL_MANAGERS = {
  brew: { command: 'brew', args: (formula: any) => ['install', formula], label: 'Homebrew' },
}
type InstallManager = keyof typeof INSTALL_MANAGERS

function isInstallManager(value: unknown): value is InstallManager {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(INSTALL_MANAGERS, value)
}

/**
 * What to do about a provider whose CLI is absent.
 *
 *   'offer-install'  we know a recipe and its package manager is present, so
 *                    the operator can be asked
 *   'report'         no recipe, or the manager itself is missing — say how to
 *                    get the CLI and move on rather than installing a package
 *                    manager as a side effect of logging in
 */
export function decideMissingCliAction({ install, managerAvailable }: any) {
  if (!install || !isInstallManager(install.manager)) return 'report'
  return managerAvailable ? 'offer-install' : 'report'
}

/** The exact command line for a recipe, for both running and printing. */
export function installCommand(install: any) {
  const managerName = install?.manager
  if (!isInstallManager(managerName)) return null
  const manager = INSTALL_MANAGERS[managerName]
  return { command: manager.command, args: manager.args(install.formula), label: manager.label }
}

export function selectProviders(requestedKeys: any) {
  if (!requestedKeys || requestedKeys.length === 0) return LOGIN_PROVIDERS

  const known = new Map(LOGIN_PROVIDERS.map((provider) => [provider.key, provider]))
  return requestedKeys.map((key: any) => {
    const provider = known.get(key)
    if (!provider) {
      throw new Error(`unknown provider '${key}' (expected one of ${[...known.keys()].join(', ')})`)
    }
    return provider
  })
}

/**
 * What `npm run login` should do about one provider.
 *
 *   'skip'         already authenticated — never re-open a browser for a
 *                  working session
 *   'login'        needs a browser sign-in
 *   'missing-cli'  the CLI is not installed; for an optional provider that is
 *                  reported and stepped over, for a required one it fails
 */
export function decideLoginAction({ cliInstalled, authenticated, force }: any) {
  if (!cliInstalled) return 'missing-cli'
  if (authenticated && !force) return 'skip'
  return 'login'
}

export function summarizeLoginResults(results: any) {
  // A required provider whose CLI is absent is just as blocking as one whose
  // sign-in failed — bootstrap cannot proceed without it either way.
  const failed = results.filter(
    (result: any) => result.status === 'failed' || (result.status === 'missing-cli' && result.required),
  )
  const skippedOptional = results.filter((result: any) => result.status === 'missing-cli' && !result.required)
  return {
    ok: failed.length === 0,
    failed: failed.map((result: any) => result.label),
    skippedOptional: skippedOptional.map((result: any) => result.label),
  }
}
