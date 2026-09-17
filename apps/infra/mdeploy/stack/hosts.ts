/*
 * The two public names a stage answers on.
 *
 * Here rather than beside the component that serves them, because the callers
 * span three programs: the stack, the API's own environment, and `bootstrap/`,
 * which registers the dashboard's host with Auth0 and is type-checked without
 * this repository's engine globals. Nothing in this file names a cloud, an
 * engine or a resource.
 *
 * One function rather than the rule spelled at each site, because five of them
 * need the same answer: the certificate that covers the names, the records that
 * point them at the balancer, `DASHBOARD_URL`, `DASHBOARD_BASE_API_URL`, and
 * the callback URL Auth0 is registered with. A second derivation is a dashboard
 * served on a name the certificate omits, an API whose CORS refuses the origin
 * it is serving, or a login refused by an identity provider that matches a
 * redirect_uri exactly.
 */
export type PublicHosts = {
  /** Where the dashboard is served, and the origin the API pins CORS to. */
  dashboard: string
  /** Where the SDKs, the proxy and every runner call. */
  api: string
}

/**
 * Those two names, from the stage domain and the one optional override.
 *
 * `api.<domain>` is derived and stays derived: a runner is handed it at first
 * boot, in a systemd unit `runner-update.ts` does not rewrite, and the in-VPC
 * private zone answers for that one name — so it is the stage's domain that
 * moves the API, never a setting of its own. The dashboard is the half that
 * takes an override, because it is the half a stage may want off the domain
 * `api.` is prefixed to.
 */
export const publicHostsFor = ({
  domain,
  dashboardDomain = null,
}: {
  domain: string
  /** Where the dashboard is served, or null for the stage domain itself. */
  dashboardDomain?: string | null
}): PublicHosts => {
  const dashboard = dashboardDomain?.trim() || domain
  const api = `api.${domain}`
  // Refused here rather than at the apply: the two would claim one DNS record
  // and one certificate, and the provider would fail on whichever it built
  // second, naming a resource collision instead of the setting behind it.
  if (dashboard === api) {
    throw new Error(
      `DASHBOARD_DOMAIN is ${dashboard}, which is where this stage's control plane answers. ` +
        'The dashboard needs a name of its own, or none at all to share the stage domain.',
    )
  }
  return { dashboard, api }
}
