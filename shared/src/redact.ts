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
