# Networking

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

### libslirp (alternative)

QEMU's user-mode networking stack.

**Use case:** Environments where gvproxy isn't available.

## Service access across runtimes

The box network tunnel API is portable across local and REST runtimes, but its
transport is backend-specific. `tunnel()` eagerly prepares one local gvproxy or
remote service-proxy connection. `uri()` inspects its public URI, while `connect()`
or `forward()` consumes that prepared one-shot tunnel into a byte stream or listener.

Explicit host port publication is a separate local-runtime feature that owns a
TCP listener and accepts repeated connections.

## Network configuration

Boxes receive network configuration via DHCP:

- IP address from virtual subnet
- Default gateway
- DNS servers (configurable, defaults to host resolvers)
