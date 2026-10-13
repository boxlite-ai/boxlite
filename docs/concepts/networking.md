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
transport is backend-specific. `tunnel()` eagerly prepares one local gvproxy or
remote service-proxy connection. `uri()` inspects its public URI, while `connect()`
or `forward()` consumes that prepared one-shot tunnel into a byte stream or listener.
For a remote box with inbound access enabled, preparing the tunnel registers that
guest port as public. The proxy accepts HTTP/WebSocket previews, including signed
URLs, and raw CONNECT only when inbound access is enabled and the port has an
active declaration. Getting a preview URL alone does not declare the port. Boxes
with inbound access disabled cannot expose guest service ports through previews,
even with a credential. The dashboard's web terminal does not use previews: it
runs a TTY execution over the `/v1` attach WebSocket, signing the upgrade with a
one-time ticket because a browser cannot send `Authorization` on a WebSocket.

Explicit host port publication is a separate local-runtime feature that owns a
TCP listener and accepts repeated connections.

## Network configuration

Boxes receive network configuration via DHCP:

- IP address from virtual subnet
- Default gateway
- DNS servers (configurable, defaults to host resolvers)
