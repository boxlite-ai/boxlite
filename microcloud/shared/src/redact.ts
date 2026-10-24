/**
 * Masks credentials in text that is about to be shown to a person or an agent: App keys, box tokens
 * and the password part of database URLs. Applied to every byte the CLI prints, errors included.
 */
const RULES: [RegExp, (match: string, ...groups: string[]) => string][] = [
  [/bxl_app_[A-Za-z2-7]{6,}/g, (m) => `bxl_app_…${m.slice(-4)}`],
  [/bxt_[A-Za-z2-7]{6,}/g, (m) => `bxt_…${m.slice(-4)}`],
  [/\b(postgres(?:ql)?:\/\/)([^:@\s/'"]+):([^@\s'"]+)@/gi, (_m, scheme, user) => `${scheme}${user}:****@`],
];

export function redact(text: string): string {
  let out = text;
  for (const [re, replace] of RULES) out = out.replace(re, replace as (substring: string, ...args: unknown[]) => string);
  return out;
}

/** What a secret value is replaced with wherever the CLI or the control plane lists it. */
export const MASKED = '********';

/** Credentials a file in an upload must not carry (check.ts warns about them). */
export const UPLOAD_SECRETS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/AKIA[0-9A-Z]{16}/, 'an AWS access key id'],
  [/sk-[A-Za-z0-9]{20,}/, 'an API secret key'],
  [/bxl_app_/, 'a BoxLite App key'],
];

/** Text kept for later sessions (App notes) must hold no credential of any kind. */
const STORED_SECRETS: [RegExp, string][] = [
  ...UPLOAD_SECRETS,
  [/blk_[A-Za-z0-9_]{16,}/, 'a BoxLite platform key'],
  [/gh[pousr]_[A-Za-z0-9]{30,}/, 'a GitHub token'],
  [/xox[abprs]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
  [/napi_[a-z0-9]{20,}/, 'a Neon API key'],
  [/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^:@\s/]+:[^@\s]+@/i, 'a database URL with its password'],
];

/** What kind of credential `text` contains, if any. */
export function secretKindIn(text: string): string | undefined {
  return STORED_SECRETS.find(([re]) => re.test(text))?.[1];
}
