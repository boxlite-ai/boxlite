# Networking

## TL;DR

BoxLite provides isolated networking with optional outbound secret header injection.

BoxLite supports pluggable network backends for Box connectivity.

## Available backends

### gvproxy (default)

User-mode networking based on gVisor's network stack.

```text
Box                    gvproxy                  Internet
┌──────┐              ┌───────┐              ┌──────────┐
│ eth0 │◄────vsock───▶│       │◄────TCP/UDP─▶│          │
└──────┘              │ NAT   │              │ External │
                      │ DHCP  │              │ Services │
                      │ DNS   │              └──────────┘
                      └───────┘
```

**Features:**

- Full outbound internet access
- Local port publication (TCP)
- Local one-shot service tunnels
- Built-in DHCP and DNS
- Network metrics (bytes sent/received)

### Secret injection certificates

Each box uses a persisted, ten-year MITM CA whose private key stays on the host.
Host certificates last at most 24 hours and renew on demand within the CA validity.
On a full stop/start, CAs with at most 30 days remaining renew using the same key;
container initialization replaces their old guest trust entries before startup.
This migrates the original 24-hour CAs. Upgrading the host runtime and guest binary
and fully restarting existing boxes is required; reattaching or resuming a running
proxy does not renew its CA or reload application trust stores.

### libslirp (alternative)

QEMU's user-mode networking stack.

**Use case:** Environments where gvproxy isn't available.

## Service access across runtimes

The box network tunnel API is portable across local and REST runtimes, but its
transport is backend-specific. On both runtimes `tunnel()` only prepares: it
checks that the box can carry the tunnel and, on a REST runtime, mints its public
URI, but opens no connection. `uri()` inspects that URI. `connect()`, or each
client of `forward()`, opens the connection, so it fails while nothing in the box
listens on the port. Both `connect()` and every forwarded client reuse the
prepared URI; forwarding never declares or restores a revoked tunnel.
For a remote box with inbound access enabled, preparing the tunnel registers
that guest port as public by default. Setting `isPublic=false` creates a private
cloud tunnel with its own persistent token. It does not wake a stopped box with auto-resume on;
the `CONNECT` does. A box whose auto-resume is off, or whose state cannot
resume, is refused at once.
`revoke_tunnel(port)` withdraws that declaration, for one port: new requests
and `CONNECT`s to its URI get `404` within 3 seconds, while connections already
open run until they close. It is safe to repeat, needs neither inbound access
nor a running box, and preparing the port again reopens it at the same URI.
On a local runtime nothing is published, so it does nothing.

### Domains

A hosted deployment can give a box port a name of its own instead of the
generated `<port>-<box>` hostname. Domains are the organization's, not a
box's, so they live under `/v1/domains` and a box port is only what one routes
to:

```bash
boxlite domain bind demo1.apps.example --type box --box web-a --port 3000   # PUT /v1/domains/demo1.apps.example/target
boxlite domain ls                                             # GET /v1/domains
boxlite domain unbind demo1.apps.example                      # DELETE /v1/domains/demo1.apps.example/target
```

The SDKs expose the same three calls as `runtime.domains`: `list()`,
`bind(domain, target)` and `unbind(domain)`. A target is
`{"type": "box", "box": <id or name>, "port": 3000}`; `type` leaves room for
other kinds of target without changing the call. The CLI requires the same
explicit choice as `--type box`, with `--box` and `--port` required for that
type; no other CLI target types are currently supported. Bind and unbind require
an owned full hostname, such as `demo1.apps.example`; short labels and URLs are
rejected. Request names separately in **Dashboard → Domains**, alongside Images
and Volumes: enter a short name (`demo1`), preview its full hostname, then submit.
The page lists every acquired hostname and its Box/port, App reference, or unbound
state. App binding is reserved and remains unsupported.

`POST /v1/domains` with `{"name":"demo1"}` acquires the full hostname without a
binding. Repeating a request for your own name preserves its target. Binding
never acquires a name: a missing or foreign hostname returns `404 domain_not_owned`
and directs the caller to Dashboard → Domains. List returns full hostnames.
Each stage serves named apps under its own user domain, a registrable domain separate from the
platform's (see [Deployment](../../apps/infra/docs/deployment.md#cloudflare-api-token));
`apps.example` stands in for it here.

Binding records which box port a name routes to and returns the domain's
URL. It does not declare the port public: the name answers once the tunnel
API has prepared the port in its default public mode and the box has inbound
access enabled, in either order. It returns `404` for private tunnels, revoked
ports, or disabled inbound access. A private tunnel remains accessible through
its generated URL using its token or an authorized platform credential.

For a public tunnel, HTTP, WebSocket and `CONNECT` work through the name as on
the generated hostname, including waking a stopped box. The proxy resolves the
name on every request and applies the same
declaration, inbound and box-state checks, so a domain never forwards to a
port the generated hostname would refuse. Preparing a tunnel always
returns the port's generated URL; `domain ls` shows the names bound to it.

A name belongs to the organization that claimed it. Binding it to another
box port moves it there at once, with no window in which it answers nothing.
A port can have several names: binding a new one leaves the others in place.
`unbind` stops routing a name: requests that start afterwards get
`404`, connections already open run until they close, and the port's
generated URL stays public until the tunnel is revoked. An unbound name is
still the organization's — nobody else can claim it, platform names still count
against the platform allowance, and the same organization can bind it
again to any of its box ports. Destroying the box, including later cleanup of its
database row, preserves the binding: `domain ls` still shows the original Box ID
and port until explicit unbind or rebind. A destroy request first changes the
desired Box state; routing follows the actual-state checks and existing three-second
access cache. Once those checks observe a destroyed or missing Box, the name answers
`404`. Revoking the tunnel also preserves the binding: the name answers `404` while
the port is revoked, and serves again once the port is prepared as public again.
New bindings reject a Box whose destruction has already been requested or completed,
or whose database row has been removed. Deleting the owning organization releases
its names; another organization can then request them. If organization deletion
fails, ownership and bindings remain intact.

`domain ls` lists every full hostname the organization holds with what it routes to.
The default table adds the platform allowance (`limit`, `used`, `remaining`) and `min_length`,
the shortest new platform name allowed, in its footer. Custom domains appear in
the same list without using that allowance. JSON and YAML output contain only
the domain rows as an array; quiet output contains only hostnames.
The REST list includes the allowance and also provides `domain_suffix` for the request
preview, or null when requests are unavailable.
A new name must be lowercase letters, digits and hyphens,
not start or end with a hyphen, not look like `<digits>-…`, and not be one of
the platform's own names or the API's collection names (`boxes`, `images`,
`volumes`, `domains`); names held before `min_length` rose stay bindable.
A box in a region served by its own proxy cannot take a named domain
(`region_not_supported`): the app domain's wildcard record points at the
default proxy only.

#### Bring your own domain

On an enabled GCP deployment, an organization with an active subscription can add
one hostname in **Dashboard → Domains → Add custom domain**. Pending, failed and
expired setup drafts also occupy this one-per-organization allowance. Adding a
different hostname returns `400 custom_domain_count_limit_reached` until the existing
configuration is deleted; repeating the same hostname returns its existing configuration.
Platform-domain allowance remains separate, even when it is zero or full.
Pre-existing configurations are retained; an organization already above the allowance
must delete all its configurations before adding a different hostname.

1. Enter a public subdomain, such as `app.example.com`; use ASCII/Punycode, at most 220 bytes, with no wildcard or apex domain.
2. At your DNS provider, add the traffic CNAME and configuration-specific TXT shown in the guide; turn off CDN proxying.
3. Click **Check DNS / retry**, then add the certificate authorization CNAME when it appears.
4. Keep all records in place; BoxLite checks ownership and traffic DNS, requests a Google-managed certificate, and checks HTTPS at the proxy entry.
5. When the domain is **Ready**, bind a Box port in Dashboard or with the existing CLI/SDK bind operation; the public-tunnel and inbound rules above still apply.

Bind does not perform DNS challenges: it reads saved DNS and HTTPS readiness,
whose deadline is also bounded by subscription eligibility. A known custom domain returns `403 subscription_required` when
subscription is required, or `409 subscription_not_ready` / `domain_not_ready`
when its eligibility or setup is not ready. Request and response fields are unchanged.

Actual subscription expiry suspends new binds and new requests while retaining
the configuration, target and certificate. Cancelling renewal during a still-paid
period does not suspend access. Eligibility is cached in Redis for at most one day,
ending sooner at the paid-cycle deadline. Early suspension can therefore take up
to one day to appear; known cycle expiry stops new access at that deadline.
Denied eligibility and lookup failures are cached for 30 seconds so a purchase
can be recognized without waiting a day. DNS/TLS readiness lasts at most five
minutes and never beyond the eligibility deadline; an outage cannot extend it.
Existing connections are not forcibly disconnected. Recovery requires fresh DNS/TLS checks.

**Unbind** keeps the domain, HTTPS configuration and occupied allowance. **Delete configuration** in
Dashboard immediately frees the allowance, releases ownership and stops new requests, then cleans up cloud resources
asynchronously. Delete and unbind remain available after subscription expiry.
After deletion, remove the DNS records; adding the hostname again creates a new TXT challenge.

Domain responses expose `hostname`, `url` and `target`; there is no short `name`
field. CLI lists use `HOSTNAME`, including full-hostname output with `ls -q`.
Unbind selects the exact held hostname within the organization, independently of
the configured platform suffix. For example, `demo.apps.example` cannot be confused
with `demo.other.example`; case and a single trailing root dot are normalized.

The target contract also reserves `{"type":"app","app":"<app reference>"}`.
REST and SDKs can represent it, but binding an App currently returns
`400 app_target_not_supported`: the App resource, ownership validation and routing
are not implemented. Existing Box bindings and tunnel authorization are unchanged.
See the [target storage contract](../contributing/architecture/platform/schema.md#domain). Removing `name` and
extending the C target structure changes the unmerged domain API/ABI; rebuild
C consumers and update SDK callers together.

The proxy accepts HTTP/WebSocket previews, including token URLs, and raw CONNECT
only when the box has inbound access enabled and the port has an active
declaration. Getting a preview URL alone does not declare the port. A box with
inbound access disabled cannot expose guest service ports through previews,
even with a credential. The dashboard's web terminal does not use previews: it
runs a TTY execution over the `/v1` attach WebSocket, signing the upgrade with a
one-time ticket because a browser cannot send `Authorization` on a WebSocket.
Each terminal session is a new shell, ended when the terminal closes in the
dashboard; a shell left by a closed page is ended once it has had no client
for 5 minutes.
An authorized request to a declared port on a stopped box with auto-resume on wakes the box.
It succeeds if the box's `cmd` serves the port within 30 seconds; otherwise the
proxy answers `503` with `Retry-After`.

### Private cloud tunnels

Each private tunnel owns a random token. The API stores its SHA-256 hash and a
masked display value; only its first creation returns the full token. Repeated
preparation returns `{uri, isPublic, token}` with the mask. Stop/resume and
inbound toggles preserve the token. Revoke followed by explicit preparation
rotates it; changing an active tunnel's mode requires revoke first.

SDK/CLI connections use the runtime's API key or JWT. The token is for visitors
outside the organization, through `X-BoxLite-Access-Token` or
`?boxlite-access-token=...`. They do not need an SDK or API key. The browser keeps
that URL; the proxy strips the secret before forwarding to the application.
Its host-only session cookie lasts an hour and renews during its final fifteen
minutes on HTTP responses. Idle pages and established WebSockets have no response
on which to renew; reloading the token URL restores an expired browser session.
See [proxy authentication](../../apps/proxy/README.md#authentication) for isolation and rollout.

Every SDK takes the service's address as seen from the box plus tunnel options.
The address replaces the bare port argument; visibility belongs in
`TunnelOptions` rather than a separate boolean. C exposes a single
`boxlite_network_tunnel` entry point with system socket storage and typed options.
For now the IP must be loopback or the guest IP; both reach the box's
guest address, so the service must listen on all interfaces or the guest IP.

```python
tunnel = await box.network.tunnel(
    ("127.0.0.1", 3000), boxlite.TunnelOptions(is_public=False)
)
print(tunnel.uri(), tunnel.is_public(), tunnel.token())  # Save the first token securely.
forwarder = await tunnel.forward(boxlite.SocketAddress.tcp(port=8080))
await forwarder.wait()
```

```typescript
import { SocketAddress } from "node:net";

const tunnel = await box.network.tunnel(
  new SocketAddress({ address: "127.0.0.1", port: 3000 }),
  { isPublic: false },
);
console.log({ uri: tunnel.uri(), isPublic: tunnel.isPublic(), token: tunnel.token() });
const forwarder = await tunnel.forward({ type: "tcp", host: "127.0.0.1", port: 8080 });
await forwarder.wait();
```

Go uses `network.Tunnel(ctx, &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 3000},
boxlite.TunnelOptions{IsPublic: false})` and `tunnel.Descriptor()`; Rust uses
`network.tunnel("127.0.0.1:3000".parse()?, TunnelOptions { is_public: false })`.
C's `boxlite_network_tunnel` takes a system `sockaddr_storage` initialized with
`boxlite_socket_address_parse()` and typed `BoxliteTunnelOptions { .is_public = false }`;
`boxlite_tunnel_descriptor` returns the JSON result.
Omitted options are public in Python, Node and C; Go's `DefaultTunnelOptions()`
and Rust's `TunnelOptions::default()` are public.
Private mode is rejected by local runtimes.

Explicit host port publication is a separate local-runtime feature that owns a
TCP listener and accepts repeated connections.

## Network configuration

Boxes receive network configuration via DHCP:

- IP address from virtual subnet
- Default gateway
- DNS servers (configurable, defaults to host resolvers)
