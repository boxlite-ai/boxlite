/**
 * Masks credentials in text that is about to be shown to a person or an agent: App keys, box tokens
 * and the password part of database URLs. Applied to every byte the CLI prints, errors included.
 */
const RULES: [RegExp, (match: string, ...groups: string[]) => string][] = [
  [/\b([a-z][a-z0-9]{1,15}_(?:live|test|svc)_)[A-Za-z0-9]{6,}/g, (m, prefix) => `${prefix}…${m.slice(-4)}`],
  [/bxl_app_[A-Za-z2-7]{6,}/g, (m) => `bxl_app_…${m.slice(-4)}`],
  [/bxt_[A-Za-z2-7]{6,}/g, (m) => `bxt_…${m.slice(-4)}`],
  [/\b(postgres(?:ql)?:\/\/)([^:@\s/'"]+):([^@\s'"]+)@/gi, (_m, scheme, user) => `${scheme}${user}:****@`],
]

export function redact(text: string): string {
  let out = text
  for (const [re, replace] of RULES) out = out.replace(re, replace as (substring: string, ...args: unknown[]) => string)
  return out
}

/** What a secret value is replaced with wherever the CLI or the control plane lists it. */
export const MASKED = '********'

const COMMON_SECRETS: [RegExp, string][] = [
  [/AKIA[0-9A-Z]{16}/, 'an AWS access key id'],
  [/sk-[A-Za-z0-9]{20}/, 'an API secret key'],
]

/** Bump when the source admission rules change. */
export const SOURCE_SCAN_VERSION = '1'
export const SOURCE_CREDENTIAL_HINT =
  'Remove the credential from the path or contents, or exclude the file in .boxliteignore.'

const SOURCE_SECRETS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]{0,64}PRIVATE KEY-----/, 'a private key'],
  ...COMMON_SECRETS,
  [/bxl_app_[A-Za-z2-7]{32}/, 'a BoxLite App key'],
  [/bxt_[a-z2-7]{32}/, 'a BoxLite supervisor token'],
  [/\b[a-z][a-z0-9]{1,15}_(?:live|test|svc)_[A-Za-z0-9]{40}/, 'a BoxLite platform key'],
  [/gh[pousr]_[A-Za-z0-9]{36}/, 'a GitHub token'],
  [/github_pat_[A-Za-z0-9_]{82}/, 'a GitHub token'],
]

export function sourceSecretKindIn(text: string): string | undefined {
  return SOURCE_SECRETS.find(([pattern]) => pattern.test(text))?.[1]
}

export function sourceFileLabel(path: string, sha256?: string): string {
  if (!sourceSecretKindIn(path)) return path
  return sha256 === undefined ? '<source path withheld>' : `sha256:${sha256}`
}

/** Scan ASCII credential signatures across raw byte chunks, including binary files. */
export async function scanSourceSecrets(chunks: Iterable<Buffer> | AsyncIterable<Buffer>): Promise<string | undefined> {
  const windowBytes = 64 * 1024
  // Retain 128 bytes for a split pattern and one more byte for its preceding context.
  const carryBytes = 129
  let carry = ''
  for await (const chunk of chunks) {
    for (let start = 0; start < chunk.length; start += windowBytes) {
      const window = carry + chunk.toString('latin1', start, start + windowBytes)
      const kind = sourceSecretKindIn(window)
      if (kind) return kind
      // A truncated window starts mid-file. Prevent an artificial word boundary at its first byte.
      carry = window.length > carryBytes ? `_${window.slice(-carryBytes)}` : window
    }
  }
  return undefined
}

/** Text kept for later sessions (App notes) must hold no credential of any kind. */
const STORED_SECRETS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  ...COMMON_SECRETS,
  [/bxl_app_/, 'a BoxLite App key'],
  [/\b[a-z][a-z0-9]{1,15}_(?:live|test|svc)_[A-Za-z0-9]{6,}/, 'a BoxLite platform key'],
  [/blk_[A-Za-z0-9_]{16,}/, 'a BoxLite platform key'],
  [/gh[pousr]_[A-Za-z0-9]{30,}/, 'a GitHub token'],
  [/xox[abprs]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
  [/napi_[a-z0-9]{20,}/, 'a Neon API key'],
  [/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^:@\s/]+:[^@\s]+@/i, 'a database URL with its password'],
]

/** What kind of credential `text` contains, if any. */
export function secretKindIn(text: string): string | undefined {
  return STORED_SECRETS.find(([re]) => re.test(text))?.[1]
}
