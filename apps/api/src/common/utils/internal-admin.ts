export function isInternalAdmin(email: string | undefined | null, allowlist: string[]): boolean {
  if (!email) return false
  const e = email.trim().toLowerCase()
  return allowlist.some((a) => a.trim().toLowerCase() === e)
}
