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

### Where secrets are substituted

For a request to one of a secret's `hosts`, gvproxy replaces the placeholder in
request header values only. The body, the URL path and query, and WebSocket
frames pass through unchanged: a host can store or reflect them, which would
hand the real value back to the box. A host can reflect headers too, so bind a
secret only to hosts you trust with it. Box creation rejects a secret with no
hosts, an empty host entry, or an empty placeholder. A box stored before that
rule still starts and imports, and `get_or_create` still returns it.

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
The proxy accepts HTTP/WebSocket previews, including signed URLs, and raw CONNECT
only when the box has inbound access enabled and the port has an active
declaration. Getting a preview URL alone does not declare the port. A box with
inbound access disabled cannot expose guest service ports through previews,
even with a credential. The authenticated web terminal uses reserved port 22222
without a tunnel declaration.
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
