# Custom domains

PRD 08 promises that an App can bind its own domain (`[domains] custom = ["crm.acme.com"]`, Domains
tab, `boxlite-app app domains add`). Today the platform refuses it: `plan` and `deploy` answer
`not_supported_yet` and tell the agent to hand over the BoxLite URL (spec.ts `onlineChecks`). This
document is what it takes to lift that, and who owns each part.

## Why it is blocked: the BoxLite proxy routes by its own host names only

Every App URL is a BoxLite tunnel, `https://<port>-<boxid>.proxy.<zone>`. The BoxLite proxy
(`apps/proxy` in boxlite-ai/boxlite) takes the port and the Box from that host name
(`parseHost`, used by `get_box_target.go` and `tunnel.go`) and refuses any other `Host`
(`proxy.go`, "if the host is not valid, we don't proxy the request"). TLS is the zone's wildcard
certificate. So a visitor's `crm.acme.com` (a CNAME to the App URL) arrives with a host the proxy
rejects, under a certificate that does not name it. Nothing on the App platform side can fix that.

## What the BoxLite proxy needs (platform team)

1. **A host table.** `hostname → (box id, port)`, written through the BoxLite API by the owner of
   the Box (the App platform's control plane), e.g. `PUT /boxes/{id}/network/hostnames/{host}`
   `{port}` and `DELETE …`. `parseHost` falls back to it when the host is not a tunnel name.
2. **Certificates on demand.** ACME (HTTP-01 on the proxy, or TLS-ALPN-01) issued when a host is
   added and the first TLS handshake for it arrives; renewed by the proxy; issuance only for hosts
   in the table, so nobody can make the proxy request certificates for arbitrary names.
3. **A stable target to point DNS at.** One name per zone, e.g. `domains.proxy.<zone>`, with A/AAAA
   records for the proxy; customers CNAME to it (apex domains use the A records or ALIAS).
4. Everything else as for tunnels: the per-port gate, wake on request, `X-Forwarded-Host` carrying
   the custom host (the App proxy needs it to set cookies for that origin).

## What the App platform then does (this repository)

- **Ownership before routing.** `domains add crm.acme.com` creates a pending domain with a TXT
  token: `_boxlite-challenge.crm.acme.com TXT <token>`. The control plane polls DNS (resolver of
  its own, not the system one) until the TXT and the CNAME/A records are right, then writes the
  host to the proxy's table. A domain is never routed on the agent's word alone.
- **Per environment.** A custom domain belongs to one environment (main by default); creating an
  environment never copies it (PRD: "去掉自有域名").
- **Sign-in and cookies.** The App proxy treats the custom host as the environment's origin: the
  sign-in callback hand-off, `__Host-` cookies and `BOXLITE_APP_URL` follow the primary domain.
  OAuth apps of the owner's own need the new redirect URI; `auth redirect-uris` lists it.
- **Visible state.** Domains tab rows: pending DNS (with the exact records to add, copyable),
  verifying, issuing certificate, active, failing (what DNS answers now). `app context` and
  `doctor` report the same, with the record to fix. Activity records add, verify and remove.
- **The manifest stays the source.** `[domains] custom` in boxlite.toml drives it; console changes
  land in the spec like other online changes (`app pull`).

## Until then

The refusal stays, so no agent reports a domain that serves nothing. The Domains tab shows the
BoxLite address and says that bringing your own domain is not available yet.
