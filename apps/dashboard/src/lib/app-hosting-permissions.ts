/** App Hosting scopes are independent invitations on the selected organization. */
export function organizationAllowsScope(permission: string, enabled: readonly string[] = []): boolean {
  return !permission.endsWith(':apps') || enabled.includes(permission)
}
