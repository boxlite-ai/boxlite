# Networking

## TL;DR

BoxLite provides isolated networking with optional outbound secret substitution.

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

### Secret substitution certificates

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
listens on the port. `connect()` reuses the prepared URI; each forwarded client
prepares again.
For a remote box with inbound access enabled, preparing the tunnel registers
that guest port as public. It does not wake a stopped box with auto-resume on;
the `CONNECT` does. A box whose auto-resume is off, or whose state cannot
resume, is refused at once.
`revoke_tunnel(port)` withdraws that declaration, for one port: new requests
and `CONNECT`s to its URI get `404` within 3 seconds, while connections already
open run until they close. It is safe to repeat, needs neither inbound access
nor a running box, and preparing the port again reopens it at the same URI.
On a local runtime nothing is published, so it does nothing.
The proxy accepts HTTP/WebSocket previews, including signed URLs, and raw CONNECT
only when the box has inbound access enabled and the port has an active
declaration. Getting a preview URL alone does not declare the port. A box with
inbound access disabled cannot expose guest service ports through previews,
even with a credential. The dashboard's web terminal does not use previews: it
runs a TTY execution over the `/v1` attach WebSocket, signing the upgrade with a
one-time ticket because a browser cannot send `Authorization` on a WebSocket.
Each terminal session is a new shell, ended when the terminal closes in the
dashboard; a shell left by a closed page is ended once it has had no client
for 5 minutes.
A request to a declared port on a stopped box with auto-resume on wakes the box.
It succeeds if the box's `cmd` serves the port within 30 seconds; otherwise the
proxy answers `503` with `Retry-After`.

Explicit host port publication is a separate local-runtime feature that owns a
TCP listener and accepts repeated connections.

## Network configuration

Boxes receive network configuration via DHCP:

- IP address from virtual subnet
- Default gateway
- DNS servers (configurable, defaults to host resolvers)
