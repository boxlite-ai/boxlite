/**
 * Parses `npm run mstage <module> <command> -- [options] [-- <inner command>]`.
 *
 * npm consumes the first `--` and passes the rest through untouched, so options
 * survive only to the right of it. To the left, `--stage dev` becomes
 * `npm_config_stage=true` plus a stray `dev`, silently shifting every
 * positional after it. Invisible without this check, so it is reported rather
 * than acted on.
 */

const USAGE = 'npm run mstage <module> <command> -- [--stage <stage>] [options] [-- <inner command>]'

/** Options mstage understands anywhere. Each command declares which ones it needs. */
export const VALUE_OPTIONS = ['app', 'region', 'role-arn', 'role-session-name', 'select-group', 'stage', 'version']

/** Options that stand alone. Deliberately not named `yes`: npm owns `npm_config_yes`. */
export const FLAG_OPTIONS = ['confirm', 'digest', 'force', 'help', 'json', 'logout', 'values']

/** The only short options. `-f` is worth the exception because it is typed often. */
export const SHORT_ALIASES = { f: 'force' }

export const OPTION_NAMES = [...VALUE_OPTIONS, ...FLAG_OPTIONS].sort()

export type Options = Record<string, string | boolean>

export type Invocation = {
  module: string
  command: string | null
  options: Options
  /** Bare tokens, with option parsing continuing around them. `env set KEY=V`. */
  positionals: string[]
  /**
   * Everything from the first bare token onward, verbatim. npm eats the `--`
   * before an inner command, so `aws exec` takes the remainder as written.
   */
  inner: string[] | null
}

export class InvocationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvocationError'
  }
}

const npmConfigVariable = (option: string) => `npm_config_${option.replaceAll('-', '_')}`

const parseFlagValue = (option: string, raw: string | undefined): boolean => {
  if (raw === undefined) return true
  if (raw === 'true') return true
  if (raw === 'false') return false
  throw new InvocationError(`--${option} takes true or false, received "${raw}"`)
}

/**
 * Options a caller adds for itself. mdeploy shares this parser so both tools
 * read a command line alike, but its switches have no business in
 * `mstage --help` — passing them per call keeps each surface its own.
 */
export type ExtraOptions = { flags?: string[]; values?: string[] }

const usageHint = (moduleName: string): string => `For usage: npm run mstage ${moduleName} -- --help`

const readOption = (
  tokens: string[],
  index: number,
  moduleName: string,
  extra: ExtraOptions,
): { name: string; value: string | boolean; consumed: number } => {
  const flags = [...FLAG_OPTIONS, ...(extra.flags ?? [])]
  const accepted = [...OPTION_NAMES, ...(extra.flags ?? []), ...(extra.values ?? [])].sort()
  const token = tokens[index]!
  const separator = token.indexOf('=')
  const name = separator === -1 ? token.slice(2) : token.slice(2, separator)
  const inlineValue = separator === -1 ? undefined : token.slice(separator + 1)

  if (!accepted.includes(name)) {
    throw new InvocationError(
      `Unknown option --${name}. Accepted: ${accepted.map((o) => `--${o}`).join(', ')}. ${usageHint(moduleName)}`,
    )
  }
  if (flags.includes(name)) return { name, value: parseFlagValue(name, inlineValue), consumed: 1 }
  if (inlineValue !== undefined) {
    if (inlineValue === '') throw new InvocationError(`--${name} requires a value`)
    return { name, value: inlineValue, consumed: 1 }
  }

  const next = tokens[index + 1]
  if (next === undefined || next === '--' || next.startsWith('--')) {
    throw new InvocationError(`--${name} requires a value`)
  }
  return { name, value: next!, consumed: 2 }
}

const parseTokens = (argv: string[], extra: ExtraOptions): Invocation => {
  const [moduleName, ...tail] = argv
  if (!moduleName) throw new InvocationError(`usage: ${USAGE}`)
  if (moduleName.startsWith('-')) throw new InvocationError(`Expected a module name, received "${moduleName}"`)

  // A module may stand alone — `mstage deploy -- --stage dev` has no command — so an
  // option in the command slot means the module takes none. Whether that is legal
  // is the module's own business; the parser only reports what was written.
  const hasCommand = tail.length > 0 && !tail[0]!.startsWith('-')
  const command = hasCommand ? tail[0]! : null
  const rest = hasCommand ? tail.slice(1) : tail

  const options: Options = {}
  const positionals: string[] = []
  let index = 0
  let inner: string[] | null = null

  while (index < rest.length) {
    const token = rest[index]!
    if (token === '--') {
      inner = rest.slice(index + 1)
      break
    }
    if (token.startsWith('-') && !token.startsWith('--')) {
      const name = (SHORT_ALIASES as Record<string, string>)[token.slice(1)]
      if (!name) {
        const known = Object.entries(SHORT_ALIASES)
          .map(([short, long]) => `-${short} (--${long})`)
          .join(', ')
        // Spelled out in full because the separator is the part people leave
        // off, and npm silently keeps whatever precedes it.
        throw new InvocationError(
          `Unknown option "${token}". mstage's only short options are: ${known}. ${usageHint(moduleName)}`,
        )
      }
      if (name in options) throw new InvocationError(`--${name} was given more than once`)
      options[name] = true
      index += 1
      continue
    }
    // A bare token is either an argument (`env set KEY=V --stage dev`) or the
    // start of an inner command (`aws exec aws s3 ls`). Both readings are
    // returned because only the command being run can tell them apart.
    if (!token.startsWith('--')) {
      inner ??= rest.slice(index)
      positionals.push(token)
      index += 1
      continue
    }
    const { name, value, consumed } = readOption(rest, index, moduleName, extra)
    if (name in options) throw new InvocationError(`--${name} was given more than once`)
    options[name] = value
    index += consumed
  }

  return { module: moduleName, command: command ?? null, options, positionals, inner }
}

const assertNoSwallowedOptions = (environment: NodeJS.ProcessEnv, options: Options): void => {
  const swallowed = OPTION_NAMES.filter(
    (name) => environment[npmConfigVariable(name)] !== undefined && !(name in options),
  )
  if (swallowed.length === 0) return
  const written = swallowed.map((name) => `--${name}`).join(' ')
  throw new InvocationError(
    `${written} was consumed by npm instead of mstage because it appeared before the "--" separator. ` +
      `Move every option to the right of it: ${USAGE}`,
  )
}

export const parseInvocation = (
  argv: string[],
  environment: NodeJS.ProcessEnv = process.env,
  extra: ExtraOptions = {},
): Invocation => {
  let parsed: Invocation
  try {
    parsed = parseTokens(argv, extra)
  } catch (error) {
    assertNoSwallowedOptions(environment, {})
    throw error
  }
  assertNoSwallowedOptions(environment, parsed.options)
  return parsed
}
