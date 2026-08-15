// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/*
 * Which keys must never leave the operator's machine.
 *
 * This was a CI step: the deploy workflow wrote the GitHub `DEPLOY_ENV` secret out as
 * apps/infra/.env and ran this over it. The store replaced that transport, so the same policy now
 * applies at three earlier points — bootstrap refuses to load one of these into the stage's secret
 * store (bootstrap/environment.ts's deployableStageConfig), the manifest scopes what may be
 * hydrated, and deployment/stage-config.ts drops one anyway if it somehow got written by hand.
 */

import { parse } from 'dotenv'

const FORBIDDEN_DEPLOYMENT_KEYS = new Set([
  'ALLOW_DOWNGRADE',
  'API_ARTIFACT_REF',
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
  // The per-component keys win over the global one, so blocking only the global would leave the
  // redirect this entry exists to prevent wide open.
  'BOXLITE_ARTIFACT_REF',
  'BOXLITE_ARTIFACT_SOURCE',
  'BUILDX_BUILDER',
  // Listed for the same defense-in-depth reason as the AWS keys above, which the workflow also
  // already sets: every current consumer assigns this after spreading process.env, so a stage
  // secret cannot win today. It earns its place because of what it would buy if one ever stopped
  // — requireBuildLocation derives the tarball URL *and* its checksum URL from this single value,
  // so redirecting it verifies an attacker-chosen artifact against an attacker-chosen manifest.
  'RUNNER_ARTIFACT_BUCKET',
  'RUNNER_ARTIFACT_REF',
  'RUNNER_ARTIFACT_SOURCE',
  'RUNNER_CREATE_ALLOWLIST',
  'SST_BIN_PATH',
])

/*
 * Whether a key must never leave the operator's machine.
 *
 * The `AWS_ENDPOINT_URL_<SERVICE>` family is a prefix rather than a name, so a Set membership test
 * on its own would miss every member of it.
 */
export function isForbiddenDeploymentKey(key: string) {
  return FORBIDDEN_DEPLOYMENT_KEYS.has(key) || key.startsWith('AWS_ENDPOINT_URL_')
}

/*
 * Keys that stay on this machine for a reason other than the credential-context rule above: each is
 * consulted *before*, or in order to reach, the stage's secret store, so a stored copy could only
 * ever disagree with the one actually used.
 */
const STORE_EXCLUDED_KEYS = new Set([
  // Reading the store initializes every provider sst.config.ts declares, Cloudflare included, so a
  // token kept there would be needed in order to read itself. These live in SSM.
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_DEFAULT_ACCOUNT_ID',
  // deployment/sst.ts resolves the region before it reads the store, so a stored value would arrive
  // after the wrapper had already used another one — and the sst child would then see the stored one.
  'AWS_REGION',
  // Selects *which* stage's store to read, so it cannot come from inside one.
  'SST_STAGE',
  // Not consulted before the store like the others here — it is the documented local artifact knob,
  // read later by resolveReleaseVersion, and CI sets it per run from the checkout's Cargo.toml. It is
  // excluded so a stored value cannot redirect which release a deploy installs.
  'VERSION',
  /*
   * Process controls, not configuration. Hydration injects into the environment of the sst child,
   * which runs Pulumi with the deploy role's credentials, so any of these turns a stored string into
   * code execution or a moved trust boundary inside a privileged process: NODE_OPTIONS can `--require`
   * a file, the proxy and CA variables redirect or unwrap every TLS connection sst makes, and PATH and
   * the preload variables choose which binaries it runs. Named explicitly here; the prefix families
   * below cover the rest.
   */
  'NODE_OPTIONS',
  'NODE_EXTRA_CA_CERTS',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'REQUESTS_CA_BUNDLE',
  'AWS_CA_BUNDLE',
  'PATH',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  // Interpreter and tool hooks, same class: each names a file or command that a runtime executes on
  // startup, so any of them turns a stored string into code running beside the deploy credentials.
  'BASH_ENV',
  'ENV',
  'GIT_SSH_COMMAND',
  'GIT_EXTERNAL_DIFF',
  'GIT_PAGER',
  'PERL5OPT',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'RUBYOPT',
  // Round three of this list. Each names a program or config file that git or docker will execute or
  // trust: GIT_ASKPASS runs to answer a credential prompt, and DOCKER_HOST redirects every build and
  // push to a daemon of the value's choosing.
  'GIT_ASKPASS',
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_CONFIG',
  'DOCKER_CERT_PATH',
  'DOCKER_TLS_VERIFY',
])

/*
 * The secrets the stack resolves through `sst.Secret`, seeded one at a time rather than from .env.
 *
 * They share the store with the stage configuration, so `sst secret load` would overwrite them: it
 * runs after ensureOidcClientId has already prompted for OIDC_CLIENT_ID, and a .env that happens to
 * define the same key would silently replace the value just entered. Hydrating them would be wrong
 * too — stack/deploy.ts reads these through sst.Secret, never process.env.
 *
 * Pinned against the `new sst.Secret(...)` declarations by a test, so adding one there without adding
 * it here fails rather than quietly becoming clobberable.
 */
export const APP_SECRET_NAMES = [
  'OIDC_CLIENT_ID',
  'OIDC_MANAGEMENT_API_CLIENT_ID',
  'OIDC_MANAGEMENT_API_CLIENT_SECRET',
  'POSTHOG_API_KEY',
  'SVIX_AUTH_TOKEN',
  'USAGE_EXPORT_TOKEN',
]

/*
 * Whole families rather than names: PULUMI_* reconfigures the engine the deploy runs on, GIT_CONFIG*
 * covers GIT_CONFIG_GLOBAL and the GIT_CONFIG_KEY_<n>/GIT_CONFIG_VALUE_<n> pairs that inject arbitrary
 * git config (including `core.pager` and the `url.*.insteadOf` rewrites), and the proxy variables
 * exist in both cases with no canonical spelling.
 *
 * This list has now grown in three separate review rounds, which is the honest signal about it: an
 * enumeration of process controls cannot be completed. The manifest is the control that bounds
 * hydration — only keys bootstrap wrote from .env are eligible — and this is a second line behind it,
 * not the boundary itself.
 */
// SST_ and BUN_ join the prefix list rather than SST_BUN_PATH/SST_PULUMI_PATH/BUN_OPTIONS being
// named one at a time: they select the binaries sst executes, and this is the sixth review round
// to add process controls. SST_STAGE is already excluded above for its own reason.
const LOCAL_ONLY_KEY_PREFIXES = ['PULUMI_', 'npm_', 'NPM_CONFIG_', 'GIT_CONFIG', 'SST_', 'BUN_']
const PROXY_KEYS = new Set(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'])

/*
 * Whether a key belongs only to this machine, never to the stage's shared secret store.
 *
 * Three consumers, one answer: bootstrap keeps these out when it loads .env
 * (bootstrap/environment.ts's deployableStageConfig), the deploy wrapper reads only these from .env,
 * and deployment/stage-config.ts refuses to hydrate one even if something wrote it into the store by
 * hand.
 */
export function isLocalOnlyDeploymentKey(key: string) {
  if (isForbiddenDeploymentKey(key) || STORE_EXCLUDED_KEYS.has(key)) return true
  if (APP_SECRET_NAMES.includes(key)) return true
  if (PROXY_KEYS.has(key.toUpperCase())) return true
  return LOCAL_ONLY_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))
}

/*
 * Reject a malformed dotenv source before anything is written from it.
 *
 * Only the syntax. *Which* keys may be stored is decided by isLocalOnlyDeploymentKey, which filters
 * rather than refuses, so an operator whose .env legitimately holds AWS_PROFILE can still bootstrap.
 * A malformed line is a different problem: the file does not say what its author thinks it says, and
 * dotenv would skip it in silence.
 */
/*
 * Reject the lines dotenv would drop in silence — a dropped key is simply absent from the store, and
 * the failure surfaces much later as a missing value.
 *
 * The check asks the parser instead of describing it. A pattern here would be a second implementation
 * of dotenv's grammar, and the two drift in both directions: too strict and an operator is told a
 * working file is invalid (`export KEY=value` from a file that doubles as a shell script, `KEY = value`
 * from ordinary tidying, and — genuinely surprising — `KEY: value`, which dotenv 17 reads while
 * `KEY:value` and `KEY : value` it does not); too loose and the silent-drop this exists to catch gets
 * through. `deployableStageConfig` hands the same text to the same parser, so agreement is the
 * property that matters, not the shape of the rule.
 *
 * One case is line-oriented on purpose. A value quoted across lines parses for dotenv, but its
 * continuations are not assignments and there is no way to recognise one without reimplementing the
 * grammar — an unterminated quote yields a key of its own, so even "keep reading until it parses"
 * cannot tell the two apart. Such a value could never be stored regardless, because a stored value
 * cannot contain a newline, so it is refused here with a message that names both possibilities rather
 * than guessing which one it is.
 */
export function validateDotenvSyntax(source: string, label = '.env') {
  // A lone CR ends a line too — an old-Mac line ending, or a file mangled in transit. Splitting on
  // \n alone folds `A=1\rBROKEN` into one line that parses as A=1, hiding the half the parser drops.
  for (const [index, rawLine] of source.split(/\r\n|\r|\n/).entries()) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    if (Object.keys(parse(line)).length === 0) {
      throw new Error(
        `${label} line ${index + 1} is not an assignment dotenv can read; expected KEY=value. If it ` +
          'continues a value quoted across lines, note that a stored value cannot contain a newline.',
      )
    }
  }
}
