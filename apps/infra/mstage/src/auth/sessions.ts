/**
 * Whether each provider's CLI is signed in.
 *
 * Same rule throughout: mstage signs nobody in and rewrites nobody's error. It
 * reads the session a `gh auth login` or `auth0 login` left behind, and repeats
 * what the tool itself said when there is none.
 */

import { spawnSync } from 'node:child_process'

export type SignInResult = { ok: boolean; detail?: string }
export type ProviderTool = {
  /** Command lines, run in order: a provider that keeps two credentials takes two to start. */
  signIn: string[][]
  /** Command lines, run in order: a provider that keeps two credentials takes two to end. */
  signOut: string[][]
  install: { manager: string; formula: string }
  machineSignIn?: (credentials: MachineCredentials) => string[]
}
export type MachineCredentials = { domain: string; clientId: string; clientSecret: string }
type RunCommand = (command: string, args: string[], options: any) => any

const CLI_TIMEOUT_MS = 15_000

/**
 * The CLI each provider signs in through, and how to install it when missing.
 *
 * Sign-ins are interactive, so they run only under `--force` and inherit this
 * terminal. Which of these are needed is each stage's own declaration.
 */
export const PROVIDER_TOOLS: Record<string, ProviderTool> = {
  // `aws login` (CLI 2.32+) trades a browser console session for short-lived
  // credentials. Note the formula name differs from the binary name.
  aws: { signIn: [['aws', 'login']], signOut: [['aws', 'logout']], install: { manager: 'brew', formula: 'awscli' } },
  gcp: {
    /*
     * Two sign-ins, because gcloud keeps two credentials and each command
     * writes one of them. GCP_CREDENTIALS below says which reads which.
     *
     * `auth login --update-adc` looks like the one command that covers both,
     * and it is the wrong fix: it writes ADC through `DumpADCToFile`, while
     * `application-default login` writes it through
     * `DumpADCOptionalQuotaProject` (`command_lib/auth/auth_util.py:217`). The
     * difference is `quota_project_id`, so ADC would come out without the
     * project the SDKs and the Pulumi provider send as `x-goog-user-project` —
     * and `checkGcp` below mints a token, which succeeds either way. A machine
     * whose ADC still carried a quota project from an older login would notice
     * nothing.
     *
     * The cost is two browser round-trips for one `mstage login`. Accepted:
     * the alternative is a credential that is present, mints, and then bills
     * or refuses somewhere else.
     */
    signIn: [
      ['gcloud', 'auth', 'login'],
      ['gcloud', 'auth', 'application-default', 'login'],
    ],
    // Both, because the sign-in wrote both. `auth revoke` removes the local
    // account but leaves the ADC file; `application-default revoke` deletes
    // that file and leaves the account. Either alone ends half a session.
    signOut: [
      ['gcloud', 'auth', 'revoke'],
      ['gcloud', 'auth', 'application-default', 'revoke'],
    ],
    // Homebrew renamed this cask from google-cloud-sdk; the old name is only
    // an alias, which is not what a hint should teach.
    install: { manager: 'brew', formula: 'gcloud-cli' },
  },
  github: {
    signIn: [['gh', 'auth', 'login']],
    // Prompts when more than one account is known; that choice is the operator's.
    signOut: [['gh', 'auth', 'logout']],
    install: { manager: 'brew', formula: 'gh' },
  },
  auth0: {
    signIn: [['auth0', 'login']],
    // Bare form logs out the active tenant; a tenant argument targets another.
    signOut: [['auth0', 'logout']],
    install: { manager: 'brew', formula: 'auth0' },
    // `auth0 login --help`: "Authenticates the Auth0 CLI using either personal
    // credentials (user login) or client credentials (machine login). Use
    // machine login for servers, CI, or any non-interactive environments."
    machineSignIn: ({ domain, clientId, clientSecret }) => [
      'auth0',
      'login',
      '--domain',
      domain,
      '--client-id',
      clientId,
      '--client-secret',
      clientSecret,
      '--no-input',
      '--no-color',
    ],
  },
}

export const SIGN_IN_COMMANDS = Object.fromEntries(
  Object.entries(PROVIDER_TOOLS).map(([key, tool]) => [key, tool.signIn]),
)

export const SIGN_OUT_COMMANDS = Object.fromEntries(
  Object.entries(PROVIDER_TOOLS).map(([key, tool]) => [key, tool.signOut]),
)

const INSTALL_MANAGERS: Record<string, (formula: string) => string> = {
  brew: (formula: string) => `brew install ${formula}`,
}

/** @returns {string} the sentence to append when a provider's CLI is absent */
export const installHint = (provider: string): string => {
  const install = PROVIDER_TOOLS[provider]?.install
  const manager = install && INSTALL_MANAGERS[install.manager]
  return manager ? ` Install it with: ${manager(install.formula)}` : ''
}

/** @returns {{ ok: boolean, detail?: string }} */
const runInteractive = (
  provider: string,
  argv: string[] | undefined,
  runCommand: RunCommand,
  what: string,
): SignInResult => {
  if (!argv) return { ok: false, detail: `mstage has no ${what} command for ${provider}` }
  const [command, ...args] = argv as string[]
  const result = runCommand(command!, args, { stdio: 'inherit' })
  if (result.error) {
    const missing = result.error.code === 'ENOENT'
    return {
      ok: false,
      detail: missing ? `${command} is not installed.${installHint(provider)}` : result.error.message,
    }
  }
  if (result.status !== 0) return { ok: false, detail: `${argv.join(' ')} exited with ${result.status}` }
  return { ok: true }
}

export const signIn = (provider: string, runCommand: RunCommand = spawnSync as RunCommand): SignInResult => {
  const steps = SIGN_IN_COMMANDS[provider]
  if (!steps) return runInteractive(provider, undefined, runCommand, 'sign-in')
  // Stops at the first failure, where a sign-out runs every step regardless.
  // The asymmetry is the point: an abandoned sign-in leaves nothing behind to
  // clean up, and sending an operator who just cancelled one browser flow into
  // a second one is noise.
  for (const argv of steps) {
    const attempt = runInteractive(provider, argv, runCommand, 'sign-in')
    if (!attempt.ok) return attempt
  }
  return { ok: true }
}

/**
 * Ends the session mstage reads. Interactive for the same reason a sign-in is:
 * `gh auth logout` asks which account when it knows more than one, and that
 * choice belongs to the operator rather than to a default mstage invents.
 */
export const signOut = (provider: string, runCommand: RunCommand = spawnSync as RunCommand): SignInResult => {
  const steps = SIGN_OUT_COMMANDS[provider]
  if (!steps) return runInteractive(provider, undefined, runCommand, 'sign-out')
  // Every step runs, even after one fails: stopping at the first would leave the
  // credential the next one ends still on the machine, and a sign-out that ends
  // half a session is the thing being avoided here.
  const failures = steps
    .map((argv) => runInteractive(provider, argv, runCommand, 'sign-out'))
    .filter((attempt) => !attempt.ok)
  if (failures.length === 0) return { ok: true }
  return { ok: false, detail: failures.map((attempt) => attempt.detail).join('; ') }
}

/**
 * Sign in as an application rather than as a person.
 *
 * Where the credentials come from is the caller's problem — here they live in
 * the stage's secret store, which cannot be read until AWS credentials exist.
 * This only performs the exchange it is handed.
 *
 * The resulting session replaces whatever the CLI held for that tenant, so on a
 * personal machine the operator's own session is gone until they sign in again.
 */
export const signInWithClientCredentials = (
  provider: string,
  credentials: MachineCredentials,
  runCommand: RunCommand = spawnSync as RunCommand,
): SignInResult => {
  const build = PROVIDER_TOOLS[provider]?.machineSignIn
  if (!build) {
    const supported = Object.keys(PROVIDER_TOOLS).filter((key) => PROVIDER_TOOLS[key].machineSignIn)
    return { ok: false, detail: `${provider} has no machine login. Supported: ${supported.join(', ') || 'none'}` }
  }
  for (const field of ['domain', 'clientId', 'clientSecret'] as const) {
    // Never name the value, only the field: this runs with a live secret.
    if (!credentials?.[field]) return { ok: false, detail: `machine login needs a non-empty ${field}` }
  }

  const [command, ...args] = build(credentials)
  // stdio is piped, not inherited: a machine login has nothing to prompt for,
  // and its output can quote back what it was given.
  const result = runCommand(command, args, { encoding: 'utf8', timeout: CLI_TIMEOUT_MS })
  if (result.error) {
    const missing = result.error.code === 'ENOENT'
    return {
      ok: false,
      detail: missing ? `${command} is not installed.${installHint(provider)}` : result.error.message,
    }
  }
  if (result.status !== 0) {
    return { ok: false, detail: redact(result.stderr || result.stdout || `exited with ${result.status}`, credentials) }
  }
  return { ok: true }
}

/** The CLI echoes its arguments on some failures; the secret must not reach a log. */
const redact = (text: unknown, { clientSecret }: MachineCredentials): string =>
  String(text).split(clientSecret).join('***').trim().slice(0, 400)

const capture = (
  provider: string,
  command: string,
  args: string[],
  runCommand: RunCommand = spawnSync as RunCommand,
) => {
  const result = runCommand(command, args, { encoding: 'utf8', timeout: CLI_TIMEOUT_MS })
  if (result.error) {
    const missing = result.error.code === 'ENOENT'
    return {
      ok: false,
      detail: missing ? `${command} is not installed.${installHint(provider)}` : result.error.message,
    }
  }
  if (result.signal) return { ok: false, detail: `${command} did not finish (${result.signal})` }
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? '',
    detail: (result.stderr || result.stdout || `${command} exited with ${result.status}`).trim(),
  }
}

const parse = (text: string, command: string): { value?: any; failure?: string } => {
  try {
    return { value: JSON.parse(text) }
  } catch {
    return { failure: `could not read ${command} output as JSON` }
  }
}

const notSignedIn = (provider: string, detail: string) => ({
  provider,
  state: 'not signed in',
  detail,
  expiresAt: null,
})

/**
 * `gh auth status --json` always exits zero unless the CLI itself fails, so the
 * per-host `state` is what says whether the session works.
 */
/**
 * The two credentials a GCP stage runs on, and who reads each.
 *
 * `auth print-access-token` is the gcloud CLI's own session, which every plain
 * `gcloud` subcommand uses; `auth application-default print-access-token` is
 * ADC, which the Google SDKs and the Pulumi provider resolve. Neither implies
 * the other — on a workstation they are separate files — so proving only ADC
 * once reported a ready session while the next `gcloud` call died.
 *
 * Minting rather than reading a store also works on a runner, where there is no
 * user session: the question is "would a plain gcloud call authenticate", which
 * `auth list` cannot answer.
 */
const GCP_CREDENTIALS = [
  { store: 'the gcloud CLI', args: ['auth', 'print-access-token'] },
  { store: 'application default credentials', args: ['auth', 'application-default', 'print-access-token'] },
]

/**
 * Whether both of those can actually authenticate.
 *
 * Which project a stage lives in is deliberately not checked: the config
 * declares it per stage, `home.ts` hands it to every client, and the gcloud
 * calls that act on a project pass `--project` themselves. Gating on
 * `gcloud config get-value project` reported usable credentials as "not signed
 * in" over a setting the work never consults.
 *
 * No quota project is needed either — `auth login --update-adc` writes none, so
 * quota falls to the project owning the resource, and `home.ts` constructs
 * `GoogleAuth` with an explicit `projectId`.
 *
 * `checkAws` is the mirror: it proves the credential resolves and leaves the
 * region to the stage.
 */
export const checkGcp = async ({ runCommand }: { runCommand?: RunCommand } = {} as any) => {
  // From the registry rather than spelled out again: `--update-adc` is what
  // makes one sign-in cover both stores, so advice must name the same flags.
  // From the registry rather than spelled out again, and both steps, because
  // either one alone leaves the store this is about to refuse.
  const advice = `Sign in with: ${PROVIDER_TOOLS.gcp!.signIn.map((argv) => argv.join(' ')).join(' then ')}`
  for (const { store, args } of GCP_CREDENTIALS) {
    const result = capture('gcp', 'gcloud', args, runCommand)
    // Named: "not signed in" over two credentials does not say which half is
    // stale, and they fail in completely different places.
    if (!result.ok) return notSignedIn('gcp', `${store}: ${result.detail}. ${advice}`)
  }
  return {
    provider: 'gcp',
    state: 'ready',
    // No account name: neither credential carries an identity gcloud reports
    // here, and all this proved is that both can mint.
    detail: 'the gcloud CLI and application default credentials are usable',
    // The tokens expire, but both mint another on demand — no deadline to act on.
    expiresAt: null,
  }
}

export const checkGitHub = async ({ runCommand }: { runCommand?: RunCommand } = {} as any) => {
  const result = capture('github', 'gh', ['auth', 'status', '--active', '--json', 'hosts'], runCommand)
  if (!result.ok) return notSignedIn('github', `${result.detail}. Sign in with: gh auth login`)

  const parsed = parse(result.stdout, 'gh')
  if (parsed.failure) return notSignedIn('github', parsed.failure)

  const accounts = Object.values(parsed.value?.hosts ?? {}).flat() as any[]
  const active = accounts.find((account: any) => account.active)
  if (!active) return notSignedIn('github', 'no active account. Sign in with: gh auth login')
  if (active.state !== 'success') {
    return notSignedIn('github', `${active.login ?? 'account'} on ${active.host}: ${active.state}`)
  }
  return {
    provider: 'github',
    state: 'ready',
    detail: `${active.login} on ${active.host}`,
    expiresAt: null,
  }
}

export const checkAuth0 = async ({ runCommand }: { runCommand?: RunCommand } = {} as any) => {
  const result = capture('auth0', 'auth0', ['tenants', 'list', '--json', '--no-input', '--no-color'], runCommand)
  if (!result.ok) return notSignedIn('auth0', `${result.detail}. Sign in with: auth0 login`)

  const parsed = parse(result.stdout, 'auth0')
  if (parsed.failure) return notSignedIn('auth0', parsed.failure)

  const tenants = Array.isArray(parsed.value) ? parsed.value : []
  const active = tenants.find((tenant: any) => tenant.active)
  if (!active) return notSignedIn('auth0', 'no active tenant. Sign in with: auth0 login')
  return { provider: 'auth0', state: 'ready', detail: active.name, expiresAt: null }
}
