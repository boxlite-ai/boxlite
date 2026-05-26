# In-Depth Guide 07: Networking

This document describes how BoxLite provides network connectivity to lightweight VMs. It covers the full data path from host to guest, the pluggable backend architecture, DNS resolution, port forwarding, secret injection via MITM proxy, and platform-specific differences.

The document is organized in two parts:

- **Part A** -- Concise overview (recommended for first reading)
- **Part B** -- Comprehensive reference (for implementors, debuggers, and contributors)

---

# Part A: Concise Version

## A.1 Architecture at a Glance

BoxLite provides each VM with a virtual Ethernet interface (`eth0`) connected to a userspace network stack running on the host. No root privileges or kernel modules are required.

```mermaid
flowchart TB
    subgraph Host["Host Process (BoxLite Runtime)"]
        RT["BoxliteRuntime"]
        Factory["NetworkBackendFactory"]
        GV["GvisorTapBackend<br/><i>primary</i>"]
        LS["LibslirpBackend<br/><i>fallback</i>"]
        Instance["GvproxyInstance<br/>(Go via FFI)"]
        Socket["Unix Socket / TCP"]
    end

    subgraph VM["libkrun VM"]
        VirtIO["virtio-net device"]
    end

    subgraph Guest["Guest"]
        ETH["eth0<br/>192.168.127.2/24"]
        Container["Container Process"]
    end

    RT --> Factory
    Factory --> GV
    Factory -.-> LS
    GV --> Instance
    Instance --> Socket
    Socket --> VirtIO
    VirtIO --> ETH
    ETH --> Container
```

**Backend selection priority:**
1. `gvisor-tap-vsock` (gvproxy) -- primary, full-featured
2. `libslirp` -- fallback, limited feature set
3. None -- engine uses its built-in default networking

## A.2 Virtual Network Topology

Every box creates an isolated `/24` virtual network:

| Role | IP Address | MAC Address |
|------|-----------|-------------|
| Gateway (gvproxy) | `192.168.127.1` | `5a:94:ef:e4:0c:dd` |
| Guest VM (eth0) | `192.168.127.2` | `5a:94:ef:e4:0c:ee` |
| Virtual Host | `192.168.127.254` | -- |
| DNS Server | `192.168.127.1` | (same as gateway) |

- **Subnet:** `192.168.127.0/24`, MTU `1500`
- **`host.boxlite.internal`** resolves to `192.168.127.254`, which NATs to `127.0.0.1` on the host.

## A.3 Key Features

**Port Forwarding** -- Map host ports to guest ports. User-provided mappings take priority; image-exposed ports are used as fallback with 1:1 mapping.

**DNS Sinkhole** -- When `allow_net` is set, an allowlist-based DNS filter resolves only permitted hostnames. Everything else gets `0.0.0.0`. The `host.boxlite.internal` alias is always allowed.

**MITM Secret Injection** -- Secrets (e.g., API keys) are injected into outbound HTTP/HTTPS requests by replacing placeholder strings. A short-lived ECDSA P-256 CA certificate is generated per box, and gvproxy intercepts matching traffic to perform the substitution.

**Cross-Platform Support:**

| Aspect | Linux | macOS | Windows |
|--------|-------|-------|---------|
| Socket type | UnixStream | UnixDgram | TCP |
| Protocol | Qemu | VFKit | Qemu over TCP |
| libgvproxy | Static `.a` | Static `.a` | DLL (c-shared) |

## A.4 Data Path

```mermaid
flowchart LR
    A["Host App<br/>:8080"] --> B["Host OS<br/>Kernel"]
    B --> C["gvproxy<br/>(socket listener)"]
    C -->|"port forward<br/>8080 → 80"| D["Unix socket<br/>bridge"]
    D --> E["libkrun<br/>virtio-net"]
    E --> F["Guest eth0"]
    F --> G["Container<br/>:80"]
```

## A.5 Go-Rust FFI Bridge

The gvproxy backend is implemented as a Go library linked into Rust via CGO/FFI:

| FFI Function | Purpose |
|-------------|---------|
| `gvproxy_create(json_config)` | Create instance, returns ID |
| `gvproxy_destroy(id)` | Destroy instance, free resources |
| `gvproxy_get_stats(id)` | Get JSON network statistics |
| `gvproxy_set_log_callback(fn_ptr)` | Bridge Go logs to Rust tracing |
| `gvproxy_get_version()` | Get gvisor-tap-vsock version |

Logging is unified: Go `logrus` messages are forwarded to Rust's `tracing` system with target `"gvproxy"`. Enable with `RUST_LOG=gvproxy=debug`.

## A.6 Debugging Quick Reference

| Symptom | Metric to Check | Likely Cause |
|---------|-----------------|--------------|
| Connections dropped | `tcp.forward_max_inflight_drop > 0` | SYN drops due to concurrent limit |
| No network at startup | `bytes_received = 0` | gvproxy not yet initialized (~30s warmup) |
| DNS failures | `failed_connection_attempts` high | DNS sinkhole blocking or routing issue |
| Slow transfers | `retransmits` / `timeouts` high | Congestion or packet loss |

---

# Part B: Comprehensive Version

## B.1 Network Architecture Overview

BoxLite networking provides hardware-isolated VMs with full TCP/IP connectivity through a userspace network stack. The architecture achieves this without requiring root privileges, kernel modules, or host network namespace changes.

### B.1.1 Component Stack

```mermaid
flowchart TB
    subgraph HostProcess["Host Process (BoxLite Runtime)"]
        direction TB
        Runtime["BoxliteRuntime"]
        NBF["NetworkBackendFactory"]

        subgraph Backends["Pluggable Backends"]
            GVB["GvisorTapBackend"]
            LSB["LibslirpBackend"]
        end

        subgraph GvproxyStack["Gvproxy Stack"]
            GI["GvproxyInstance"]
            FFI["FFI Layer<br/>(libgvproxy-sys)"]
            GoCode["Go Layer<br/>(gvproxy-bridge)"]
        end

        SocketPath["Unix Socket<br/>/tmp/bl_{id}/net.sock"]
    end

    subgraph VMLayer["libkrun VM"]
        VirtioNet["virtio-net device<br/>(CSUM, TSO4, UFO)"]
    end

    subgraph GuestVM["Guest VM"]
        ETH0["eth0<br/>192.168.127.2/24"]
        ContainerProcess["Container Process"]
    end

    Runtime --> NBF
    NBF --> GVB
    NBF -.->|"fallback"| LSB
    GVB --> GI
    GI --> FFI
    FFI --> GoCode
    GoCode --> SocketPath
    SocketPath --> VirtioNet
    VirtioNet --> ETH0
    ETH0 --> ContainerProcess
```

### B.1.2 Backend Selection

`NetworkBackendFactory::create()` selects a backend at compile time using Cargo feature flags:

```rust
// Priority order:
// 1. gvproxy (feature = "gvproxy")  -- primary
// 2. libslirp (feature = "libslirp") -- fallback
// 3. None -- engine default
pub fn create(config: NetworkBackendConfig) -> BoxliteResult<Option<Box<dyn NetworkBackend>>>
```

When no backend is available, the function returns `None` and the engine uses its built-in networking.

## B.2 The NetworkBackend Trait

All network backends implement a common trait that decouples the engine from specific implementations:

```rust
pub trait NetworkBackend: Send + Sync + Debug {
    /// Connection info for the VM engine
    fn endpoint(&self) -> BoxliteResult<NetworkBackendEndpoint>;

    /// Human-readable backend name
    fn name(&self) -> &'static str;

    /// Network statistics (optional)
    fn metrics(&self) -> BoxliteResult<Option<NetworkMetrics>> {
        Ok(None)
    }
}
```

### B.2.1 NetworkBackendEndpoint

The endpoint tells the engine how to wire the VM's network interface:

```rust
pub enum NetworkBackendEndpoint {
    UnixSocket {
        path: PathBuf,
        connection_type: ConnectionType,
        mac_address: [u8; 6],
    },
}

pub enum ConnectionType {
    UnixStream,  // Linux: SOCK_STREAM, Qemu protocol
    UnixDgram,   // macOS: SOCK_DGRAM, VFKit protocol
}
```

### B.2.2 NetworkBackendConfig

Configuration passed to the factory to create a backend:

```rust
pub struct NetworkBackendConfig {
    pub port_mappings: Vec<(u16, u16)>,      // (host_port, guest_port)
    pub socket_path: PathBuf,                 // Unique per box
    pub allow_net: Vec<String>,               // DNS sinkhole allowlist
    pub secrets: Vec<Secret>,                 // MITM proxy secrets
    pub ca_cert_pem: Option<String>,          // MITM CA certificate
    pub ca_key_pem: Option<String>,           // MITM CA private key
}
```

## B.3 Virtual Network Topology

Each box operates within an isolated virtual network. All addresses are deterministic and hardcoded to ensure DHCP static leases work correctly.

```mermaid
graph LR
    subgraph VirtualNet["192.168.127.0/24"]
        GW["Gateway<br/>192.168.127.1<br/>5a:94:ef:e4:0c:dd"]
        VM["Guest VM<br/>192.168.127.2<br/>5a:94:ef:e4:0c:ee"]
        VH["Virtual Host<br/>192.168.127.254<br/>(NAT → 127.0.0.1)"]
    end

    DNS["DNS Server<br/>192.168.127.1"]
    HostLoop["Host Loopback<br/>127.0.0.1"]

    GW <-->|"eth0"| VM
    VM -->|"host.boxlite.internal"| VH
    VH -->|"NAT"| HostLoop
    GW --- DNS
```

### B.3.1 Address Constants

All constants are defined in `src/boxlite/src/net/constants.rs`:

| Constant | Value | Purpose |
|----------|-------|---------|
| `SUBNET` | `192.168.127.0/24` | Virtual network range |
| `GATEWAY_IP` | `192.168.127.1` | gvproxy endpoint, also DNS server |
| `GUEST_IP` | `192.168.127.2` | Static lease for guest |
| `HOST_IP` | `192.168.127.254` | NATs to `127.0.0.1` on host |
| `GUEST_CIDR` | `192.168.127.2/24` | IP assignment in guest |
| `GUEST_INTERFACE` | `eth0` | virtio-net interface name |
| `DEFAULT_MTU` | `1500` | Standard Ethernet MTU |
| `HOST_HOSTNAME` | `host.boxlite.internal` | DNS name for virtual host |
| `HOST_ALIAS_ZONE` | `boxlite.internal.` | DNS zone name |

### B.3.2 MAC Address Management

MAC addresses are hardcoded and must remain synchronized between the network backend (DHCP server) and the engine (virtio-net device):

```
Gateway MAC: 5a:94:ef:e4:0c:dd
Guest MAC:   5a:94:ef:e4:0c:ee
                            ^^ only this byte differs
```

The gateway configures a DHCP static lease mapping `GUEST_MAC` to `GUEST_IP`, ensuring the guest always receives `192.168.127.2`. If these MACs become mismatched, the guest will not receive its expected IP address.

## B.4 Gvisor-Tap-Vsock Backend (Primary)

The primary backend uses [gvisor-tap-vsock](https://github.com/containers/gvisor-tap-vsock), the same userspace network stack used by Podman. It is compiled as a Go library and linked into BoxLite via CGO/FFI.

### B.4.1 Module Structure (Rust Side)

```
src/boxlite/src/net/
  mod.rs              # NetworkBackend trait, Factory, ConnectionType
  constants.rs        # IP/MAC/DNS constants
  socket_path.rs      # Unix socket path shortening
  ca.rs               # MITM CA certificate generation
  libslirp.rs         # Fallback backend
  gvproxy/
    mod.rs            # GvisorTapBackend (implements NetworkBackend)
    config.rs         # GvproxyConfig, DnsZone, PortMapping, SecretConfig
    instance.rs       # GvproxyInstance (RAII lifecycle management)
    ffi.rs            # Safe wrappers around raw FFI calls
    logging.rs        # Go slog → Rust tracing bridge
    stats.rs          # NetworkStats, TcpStats deserialization
```

### B.4.2 Go Layer (gvproxy-bridge)

The Go code lives in `src/deps/libgvproxy-sys/gvproxy-bridge/` and is compiled into a static library (`.a` on Unix, DLL on Windows):

| File | Purpose |
|------|---------|
| `main.go` | FFI exports, instance lifecycle, virtual network creation |
| `forked_tcp.go` | TCP forwarder with AllowNet filtering and SNI inspection |
| `forked_network.go` | Forked network handler |
| `dns_filter.go` | DNS sinkhole implementation |
| `tcp_filter.go` | TCP-level IP/CIDR/hostname allowlist matching |
| `mitm_proxy.go` | HTTPS interception and secret injection |
| `mitm_replacer.go` | Streaming placeholder replacement |
| `mitm_websocket.go` | WebSocket upgrade handling through MITM |
| `sni_peek.go` | TLS SNI header extraction |
| `stats.go` | Network statistics collection via VirtualNetwork |
| `mitm.go` | MITM CA and certificate management |

### B.4.3 Go-Rust FFI Bridge

```mermaid
flowchart LR
    subgraph Rust["Rust Process"]
        direction TB
        Backend["GvisorTapBackend"]
        Instance["GvproxyInstance"]
        FFISafe["ffi.rs<br/>(safe wrappers)"]
        LibSys["libgvproxy-sys<br/>(extern C declarations)"]
        Tracing["tracing subscriber"]
    end

    subgraph CGO["CGO Boundary"]
        CHeader["C header:<br/>gvproxy_create<br/>gvproxy_destroy<br/>gvproxy_get_stats<br/>gvproxy_set_log_callback<br/>gvproxy_get_version"]
    end

    subgraph Go["Go Runtime"]
        direction TB
        Main["main.go<br/>(export functions)"]
        VN["VirtualNetwork<br/>(gvisor-tap-vsock)"]
        LogHook["RustTracingLogrusHook"]
    end

    Backend --> Instance
    Instance --> FFISafe
    FFISafe --> LibSys
    LibSys --> CHeader
    CHeader --> Main
    Main --> VN
    LogHook -->|"callback"| Tracing
```

**FFI function signatures:**

```c
// Create gvproxy instance from JSON config. Returns instance ID or -1.
long long gvproxy_create(const char* configJSON);

// Destroy instance by ID. Returns 0 on success.
int gvproxy_destroy(long long id);

// Get stats as JSON string. Caller must free with gvproxy_free_string.
char* gvproxy_get_stats(long long id);

// Register Rust log callback (Go → Rust log forwarding).
void gvproxy_set_log_callback(void* callback);

// Get version string. Caller must free with gvproxy_free_string.
char* gvproxy_get_version();

// Free a string allocated by Go.
void gvproxy_free_string(char* str);
```

### B.4.4 Logging Bridge

The logging bridge unifies Go and Rust log output. It is initialized once via `std::sync::Once` on the first `GvproxyInstance::new()` call.

```mermaid
flowchart LR
    subgraph Go["Go Runtime"]
        Logrus["logrus.Info(...)"]
        Hook["RustTracingLogrusHook"]
        Writer["RustTracingWriter<br/>(std log redirect)"]
    end

    subgraph CGO["CGO"]
        Callback["call_rust_log_callback()"]
    end

    subgraph Rust["Rust Runtime"]
        CB["gvproxy_log_callback()"]
        Tracing["tracing::info!<br/>target: gvproxy"]
    end

    Logrus --> Hook
    Hook --> Callback
    Writer --> Callback
    Callback --> CB
    CB --> Tracing
```

**Log level mapping:**

| Go Level | Rust Level | Value |
|----------|-----------|-------|
| `logrus.TraceLevel` | `tracing::trace!` | 0 |
| `logrus.DebugLevel` | `tracing::debug!` | 1 |
| `logrus.InfoLevel` | `tracing::info!` | 2 |
| `logrus.WarnLevel` | `tracing::warn!` | 3 |
| `logrus.ErrorLevel+` | `tracing::error!` | 4 |

**Controlling gvproxy log output:**

```bash
# Show gvproxy debug logs
RUST_LOG=gvproxy=debug cargo run

# Show only gvproxy warnings and errors
RUST_LOG=gvproxy=warn cargo run
```

### B.4.5 Instance Lifecycle

```mermaid
sequenceDiagram
    participant App as BoxLite Runtime
    participant Backend as GvisorTapBackend
    participant Instance as GvproxyInstance
    participant FFI as ffi.rs
    participant Go as Go (main.go)
    participant VN as VirtualNetwork

    App->>Backend: GvisorTapBackend::new(config)
    Backend->>Instance: GvproxyInstance::new(socket_path, ports, ...)
    Instance->>Instance: logging::init_logging() (Once)
    Instance->>FFI: create_instance(GvproxyConfig)
    FFI->>FFI: serde_json::to_string(config)
    FFI->>Go: gvproxy_create(json_c_str)
    Go->>Go: Parse JSON config
    Go->>Go: Create platform socket (Unix/TCP)
    Go->>Go: Build types.Configuration
    Go->>VN: virtualnetwork.New(tapConfig)
    Go->>Go: Start Accept goroutine
    Go-->>FFI: instance_id
    FFI-->>Instance: id
    Instance-->>Backend: GvproxyInstance

    Note over Backend: Stats logging task started (30s interval)

    App->>Backend: backend.endpoint()
    Backend-->>App: NetworkBackendEndpoint::UnixSocket{...}

    Note over App: Engine configures VM with endpoint

    App->>Backend: Drop
    Backend->>Instance: Drop (Arc refcount → 0)
    Instance->>FFI: destroy_instance(id)
    FFI->>Go: gvproxy_destroy(id)
    Go->>Go: Cancel context, close sockets
    Go-->>FFI: 0 (success)
```

### B.4.6 Network Statistics

Statistics are collected by invoking the VirtualNetwork's built-in `/stats` HTTP handler via `httptest` (no actual HTTP server):

```rust
pub struct NetworkStats {
    pub bytes_sent: u64,
    pub bytes_received: u64,
    pub tcp: TcpStats,
}

pub struct TcpStats {
    pub forward_max_inflight_drop: u64,  // Critical: SYN drops
    pub current_established: u64,
    pub failed_connection_attempts: u64,
    pub retransmits: u64,
    pub timeouts: u64,
}
```

A background Tokio task logs statistics every 30 seconds. It holds a `Weak<GvproxyInstance>` reference so the instance is not kept alive by the logging task.

## B.5 Port Forwarding

### B.5.1 Port Mapping Sources

Port mappings come from two sources (user-provided takes priority):

1. **User-provided** -- Explicitly specified in `BoxOptions`
2. **Image-exposed** -- Extracted from OCI image manifest `ExposedPorts`, mapped 1:1 (only when user does not override)

### B.5.2 Forwarding Flow

```mermaid
sequenceDiagram
    participant User as User Config
    participant RT as BoxLite Runtime
    participant Config as GvproxyConfig
    participant Go as Go (gvproxy)
    participant VN as VirtualNetwork
    participant Guest as Guest :80

    User->>RT: port_mappings: [(8080, 80)]
    RT->>Config: GvproxyConfig::new(socket, [(8080, 80)])
    Config->>Config: PortMapping { host: 8080, guest: 80 }
    RT->>Go: gvproxy_create(json)
    Go->>Go: tapConfig.Forwards["0.0.0.0:8080"] = "192.168.127.2:80"
    Go->>VN: virtualnetwork.New(tapConfig)
    VN->>VN: Listen on 0.0.0.0:8080 (host)

    Note over VN,Guest: When traffic arrives on host:8080

    VN->>VN: Accept connection on :8080
    VN->>Guest: Forward to 192.168.127.2:80
    Guest-->>VN: Response
    VN-->>VN: Relay back to caller
```

**Important:** The forward format in Go is `"0.0.0.0:{host_port}" → "{guest_ip}:{guest_port}"`. The `tcp://` prefix must NOT be used (it causes "too many colons in address" errors).

## B.6 DNS Resolution

### B.6.1 Built-in DNS

gvproxy runs an embedded DNS server at `192.168.127.1:53`. It serves:

1. **Built-in zones** -- `boxlite.internal.` zone with a single A record: `host` -> `192.168.127.254`
2. **User-defined zones** -- Custom `DnsZone` entries added via configuration
3. **Forwarded queries** -- Anything not matching a local zone is forwarded to the host system DNS resolver

```mermaid
flowchart TB
    Guest["Guest DNS Query<br/>e.g., host.boxlite.internal"]
    DNS["Embedded DNS<br/>192.168.127.1:53"]

    subgraph Zones["Zone Matching (first-match-wins)"]
        Z1["boxlite.internal.<br/>host → 192.168.127.254"]
        Z2["User zones<br/>(if configured)"]
        Z3["Sinkhole zones<br/>(if allow_net active)"]
        ZCatch["Catch-all root zone<br/>→ 0.0.0.0<br/>(sinkhole only)"]
    end

    Forward["Host System DNS<br/>(upstream resolver)"]
    Result["DNS Response"]

    Guest --> DNS
    DNS --> Z1
    Z1 -->|"match"| Result
    Z1 -->|"no match"| Z2
    Z2 -->|"match"| Result
    Z2 -->|"no match"| Z3
    Z3 -->|"match (sinkhole)"| Result
    Z3 -->|"no match"| ZCatch
    ZCatch -->|"sinkhole active"| Result
    Z2 -->|"no sinkhole"| Forward
    Forward --> Result
```

### B.6.2 DnsZone Configuration

```rust
pub struct DnsZone {
    pub name: String,              // Zone name, e.g., "boxlite.internal."
    pub records: Vec<DnsRecord>,   // Exact A records
    pub default_ip: String,        // Default IP for unmatched (empty = exact only)
}

pub struct DnsRecord {
    pub name: String,  // Record label within zone, e.g., "host"
    pub ip: String,    // IPv4 address
}
```

### B.6.3 DNS Sinkhole (allow_net)

When `allow_net` is non-empty, a sinkhole filter blocks DNS resolution for non-allowlisted hosts:

```mermaid
flowchart TB
    Config["allow_net: [api.openai.com, *.github.com]"]

    subgraph Build["buildAllowNetDNSZones()"]
        direction TB
        Resolve["Resolve allowed hostnames<br/>→ A records"]
        ExactZone["Zone: openai.com.<br/>Record: api → resolved IPs"]
        WildZone["Zone: github.com.<br/>Regexp: .* (match all subdomains)"]
        CatchAll["Root zone: (empty)<br/>DefaultIP: 0.0.0.0"]
    end

    Config --> Build
    Resolve --> ExactZone
    Resolve --> WildZone
    Build --> CatchAll

    subgraph Runtime["DNS Query Resolution"]
        Q1["api.openai.com?<br/>→ Matches zone, returns real IPs"]
        Q2["sub.github.com?<br/>→ Matches wildcard, returns real IPs"]
        Q3["evil.example.com?<br/>→ No match → catch-all → 0.0.0.0"]
    end
```

**Key behaviors:**
- `host.boxlite.internal` is always allowed (built-in zone has priority)
- IP addresses and CIDRs in `allow_net` are handled by TCP-level filtering, not DNS
- Hostnames are resolved at filter creation time and cached as A records
- A catch-all root zone with `0.0.0.0` sinkoles everything not explicitly allowed

### B.6.4 TCP-Level Filtering

In addition to DNS sinkhole, a `TCPFilter` operates at the connection level:

```rust
// Supported rule types:
// - Exact IP: "1.2.3.4"
// - CIDR: "10.0.0.0/8"
// - Exact hostname: "api.openai.com" (checked via SNI/Host header)
// - Wildcard: "*.example.com" (suffix match)
```

For ports 443 and 80, the forwarder peeks at TLS SNI (port 443) or HTTP Host header (port 80) to determine the destination hostname, then checks it against the allowlist before forwarding.

Internal IPs (gateway, guest, virtual host) are always allowed.

## B.7 MITM Proxy and Secret Injection

The MITM proxy allows BoxLite to inject secrets (e.g., API keys) into outbound HTTP/HTTPS requests without exposing them inside the guest VM.

### B.7.1 Secret Configuration

```rust
pub struct Secret {
    pub name: String,           // e.g., "openai"
    pub hosts: Vec<String>,     // e.g., ["api.openai.com"]
    pub placeholder: String,    // e.g., "<BOXLITE_SECRET:openai>"
    pub value: String,          // e.g., "sk-actual-key-value"
}
```

Guest code uses the placeholder string in requests. The MITM proxy transparently replaces placeholders with actual secret values before the request leaves the host.

### B.7.2 MITM Flow

```mermaid
sequenceDiagram
    participant Guest as Guest Container
    participant GVP as gvproxy (Go)
    participant CA as BoxCA
    participant Upstream as api.openai.com

    Note over Guest,GVP: Guest has MITM CA in its trust store

    Guest->>GVP: HTTPS to api.openai.com<br/>Authorization: Bearer <BOXLITE_SECRET:openai>

    GVP->>GVP: SNI peek → "api.openai.com"
    GVP->>GVP: SecretHostMatcher → secrets found

    GVP->>CA: GenerateHostCert("api.openai.com")
    CA-->>GVP: TLS certificate for api.openai.com

    GVP->>GVP: TLS terminate guest connection<br/>(using generated cert)

    GVP->>GVP: substituteHeaders(req, secrets)<br/>Replace placeholder → real key

    GVP->>GVP: secretTransport.RoundTrip()<br/>Replace placeholders in body

    GVP->>Upstream: HTTPS request with real API key
    Upstream-->>GVP: Response
    GVP-->>Guest: Response (unmodified)
```

### B.7.3 CA Certificate Management

```rust
// Rust side: src/boxlite/src/net/ca.rs
pub struct MitmCa {
    pub cert_pem: String,
    pub key_pem: String,
}

// Generated: ECDSA P-256, 24h validity, self-signed
// Persisted: {box_dir}/ca/cert.pem (0644), key.pem (0600)
// Reloaded on box restart to maintain guest trust store consistency
pub fn load_or_generate(ca_dir: &Path) -> BoxliteResult<MitmCa>
```

The CA certificate is:
1. Generated by Rust using `rcgen` (ECDSA P-256, 24-hour validity)
2. Persisted to `{box_dir}/ca/` for restart consistency
3. Passed to Go via the JSON config (`ca_cert_pem`, `ca_key_pem`)
4. Injected into the guest's trust store during container initialization

### B.7.4 WebSocket Support

WebSocket connections through MITM-intercepted hosts are supported:
- Upgrade requests are detected via `Connection: upgrade` + `Upgrade: websocket` headers
- Secret substitution applies to request headers only
- After the 101 handshake, frames are relayed bidirectionally without modification
- This is by design: WebSocket frames may be arbitrarily fragmented, making reliable body substitution impractical

## B.8 Engine Integration

### B.8.1 Virtio-Net Feature Flags

The engine configures the VM's virtio-net device with these feature flags (defined in `src/boxlite/src/vmm/krun/constants.rs`):

| Flag | Bit | Description |
|------|-----|-------------|
| `NET_FEATURE_CSUM` | 0 | Partial checksum offload |
| `NET_FEATURE_GUEST_CSUM` | 1 | Guest handles partial checksum |
| `NET_FEATURE_GUEST_TSO4` | 7 | Guest can receive TSOv4 |
| `NET_FEATURE_GUEST_UFO` | 10 | Guest can receive UFO |
| `NET_FEATURE_HOST_TSO4` | 11 | Host can receive TSOv4 |
| `NET_FEATURE_HOST_UFO` | 14 | Host can receive UFO |
| `NET_FLAG_VFKIT` | 0 | Send VFKit magic handshake (macOS only) |

### B.8.2 Platform Dispatch

```mermaid
flowchart TB
    Endpoint["NetworkBackendEndpoint::UnixSocket"]
    ConnType{ConnectionType?}

    Linux["krun_add_net_unixstream()<br/>path, fd=-1, mac, features, flags=0"]
    Mac["krun_add_net_unixgram()<br/>path, fd=-1, mac, features, flags=NET_FLAG_VFKIT"]
    Win["krun_add_net()<br/>tcp://127.0.0.1:port, mac"]

    Endpoint --> ConnType
    ConnType -->|UnixStream| Linux
    ConnType -->|UnixDgram| Mac
    ConnType -->|Windows| Win
```

Platform-specific behavior in the engine (`vmm/krun/context.rs`):

- **Linux:** `krun_add_net_unixstream(ctx, path, -1, mac, features, 0)` -- SOCK_STREAM, Qemu protocol
- **macOS:** `krun_add_net_unixgram(ctx, path, -1, mac, features, NET_FLAG_VFKIT)` -- SOCK_DGRAM, VFKit protocol with magic handshake
- **Windows:** `krun_add_net(ctx, endpoint, mac)` -- TCP endpoint string

### B.8.3 Platform Socket Creation (Go Side)

```mermaid
flowchart TB
    Config["GvproxyConfig"]
    HasListenAddr{"listen_addr set?"}

    TCP["net.Listen('tcp', addr)<br/>Qemu protocol"]
    IsDarwin{"runtime.GOOS == 'darwin'?"}
    UnixDgram["transport.ListenUnixgram()<br/>VFKit protocol"]
    UnixStream["net.Listen('unix', path)<br/>Qemu protocol"]

    Config --> HasListenAddr
    HasListenAddr -->|"yes (Windows)"| TCP
    HasListenAddr -->|"no"| IsDarwin
    IsDarwin -->|"yes"| UnixDgram
    IsDarwin -->|"no (Linux)"| UnixStream
```

## B.9 Guest Network Configuration

After the VM boots, the host sends a `Guest.Init` RPC containing network configuration:

```rust
// Sent from host to guest via gRPC over vsock
NetworkInitConfig {
    interface: "eth0",           // GUEST_INTERFACE
    ip: Some("192.168.127.2/24"), // GUEST_CIDR
    gateway: Some("192.168.127.1"), // GATEWAY_IP
}
```

The guest agent configures the network using `rtnetlink` (pure Rust netlink library, no dependency on the `ip` command):

1. Bring up `lo` loopback interface
2. Find `eth0` interface (created by virtio-net)
3. Bring up `eth0`
4. Assign IP address `192.168.127.2/24`
5. Add default route via `192.168.127.1`
6. Verify configuration (debug mode)

## B.10 Socket Path Shortening

### B.10.1 The Problem

Unix domain sockets have a `sun_path` buffer limit:
- **macOS:** 104 bytes
- **Linux:** 108 bytes

BoxLite socket paths like `~/.boxlite/boxes/{box_id}/sockets/net.sock` can exceed this limit.

### B.10.2 The Solution

Create a short symlink in `/tmp` that points to the real sockets directory:

```
/tmp/bl_{short_id}  →  ~/.boxlite/boxes/{box_id}/sockets/
```

The kernel resolves symlinks during VFS path lookup AFTER the `sun_path` length check, so the short symlink path satisfies the buffer constraint while the socket file physically lives at the real (long) path.

```mermaid
flowchart LR
    subgraph ShortPath["Short Path (< 104 bytes)"]
        Symlink["/tmp/bl_aB3xK9Lm/net.sock"]
    end

    subgraph RealPath["Real Path (may exceed 104 bytes)"]
        Real["~/.boxlite/boxes/abc123def456.../sockets/net.sock"]
    end

    Symlink -->|"symlink"| Real

    Bind["bind() uses short path"]
    Kernel["Kernel resolves symlink<br/>after sun_path check"]

    Bind --> Symlink
    Symlink --> Kernel
    Kernel --> Real
```

### B.10.3 Implementation Details

```rust
pub struct SocketShortener {
    symlink_path: PathBuf,  // /tmp/bl_{short_id}
    real_dir: PathBuf,      // ~/.boxlite/boxes/{id}/sockets/
}

impl SocketShortener {
    // Returns Ok(None) if paths already fit, or on Windows
    pub fn new(short_id: &str, sockets_dir: &Path) -> BoxliteResult<Option<Self>>;

    // Get short path for a socket file
    pub fn short_path(&self, socket_name: &str) -> PathBuf;
}

impl Drop for SocketShortener {
    fn drop(&mut self) { /* removes symlink */ }
}
```

**Stale symlink cleanup:** `cleanup_stale_symlinks()` runs at runtime startup and removes `/tmp/bl_*` symlinks whose targets no longer exist (left behind by crashed processes).

**Library safety:** BoxLite is a library -- it never changes the host process's CWD. The symlink approach avoids any process-global state mutation.

**Windows:** `SocketShortener::new()` always returns `Ok(None)` -- AF_UNIX on Windows does not have the same path length limitation, and Windows typically uses TCP ports instead.

## B.11 Platform Differences

```mermaid
flowchart TB
    subgraph Linux["Linux"]
        L1["UnixStream (SOCK_STREAM)"]
        L2["Qemu protocol"]
        L3["krun_add_net_unixstream()"]
        L4["Static .a library"]
        L5["Links: glibc, libresolv"]
    end

    subgraph macOS["macOS"]
        M1["UnixDgram (SOCK_DGRAM)"]
        M2["VFKit protocol + magic"]
        M3["krun_add_net_unixgram()"]
        M4["Static .a library"]
        M5["Links: CoreFoundation, Security"]
    end

    subgraph Windows["Windows"]
        W1["TCP ports (127.0.0.1:0)"]
        W2["Qemu over TCP"]
        W3["krun_add_net()"]
        W4["DLL (c-shared)"]
        W5["Dynamic linking"]
    end
```

### B.11.1 Detailed Comparison

| Aspect | Linux | macOS | Windows |
|--------|-------|-------|---------|
| **Connection type** | `UnixStream` (SOCK_STREAM) | `UnixDgram` (SOCK_DGRAM) | TCP ports |
| **Wire protocol** | Qemu (length-prefixed) | VFKit (magic handshake) | Qemu over TCP |
| **libgvproxy build** | Static archive (`.a`) | Static archive (`.a`) | DLL (c-shared) |
| **System libraries** | glibc, libresolv | CoreFoundation, Security | Dynamic |
| **Socket creation** | `net.Listen("unix", path)` | `transport.ListenUnixgram(uri)` | `net.Listen("tcp", addr)` |
| **libkrun FFI** | `krun_add_net_unixstream()` | `krun_add_net_unixgram()` | `krun_add_net()` |
| **Port allocation** | N/A (deterministic paths) | N/A (deterministic paths) | `allocate_port()` binds `127.0.0.1:0` |
| **Socket shortening** | Symlink if needed | Symlink if needed | No-op |

### B.11.2 Windows TCP Port Allocation

On Windows, Unix sockets are unavailable. Each box allocates three ephemeral TCP ports:

```rust
pub struct BoxPorts {
    pub grpc_port: u16,   // gRPC transport (host <-> guest)
    pub ready_port: u16,  // Ready signal
    pub net_port: u16,    // Network backend traffic
}

pub fn allocate_port() -> BoxliteResult<u16> {
    // Bind 127.0.0.1:0, read OS-assigned port, drop listener
    let listener = TcpListener::bind("127.0.0.1:0")?;
    Ok(listener.local_addr()?.port())
}
```

The small TOCTOU window between port allocation and subsequent bind is acceptable because the ephemeral port pool is large (~16k ports).

## B.12 Network Failures and Debugging

### B.12.1 Key Metrics

| Metric | Normal Value | Alarm Condition | Meaning |
|--------|-------------|-----------------|---------|
| `tcp.forward_max_inflight_drop` | 0 | > 0 | SYN packets dropped due to concurrent connection limit (default `maxInFlight=10`) |
| `bytes_received` | > 0 after ~30s | 0 after 30s | Network backend not initialized or guest not configured |
| `tcp.failed_connection_attempts` | Low | Rapidly increasing | DNS resolution failure, routing issue, or sinkhole blocking |
| `tcp.retransmits` | Low | High relative to segments | Network congestion or packet loss |
| `tcp.timeouts` | 0 | > 0 | RTO (retransmission timeout) events -- severe congestion |
| `tcp.current_established` | Matches expected | Unexpectedly 0 | All connections dropped or failed |

### B.12.2 Debugging Tools

**Enable debug logging:**

```bash
# All gvproxy logs
RUST_LOG=gvproxy=debug python my_script.py

# Packet capture to pcap file
BOXLITE_NET_CAPTURE_FILE=/tmp/capture.pcap python my_script.py
# Then analyze with Wireshark
```

**Check statistics programmatically:**

```rust
let backend = GvisorTapBackend::new(config)?;
let stats = backend.get_stats()?;

if stats.tcp.forward_max_inflight_drop > 0 {
    warn!("TCP connections being dropped: {}", stats.tcp.forward_max_inflight_drop);
}
```

### B.12.3 Common Issues

**No connectivity after box start:**
- gvproxy needs approximately 30 seconds to fully initialize the virtual network
- The `bytes_received = 0` metric confirms the network is not yet ready
- The stats logging task waits 30 seconds before its first check for this reason

**DNS resolution fails inside guest:**
- Verify `allow_net` configuration if DNS sinkhole is active
- Check `host.boxlite.internal` resolves correctly (always allowed)
- DNS server is at `192.168.127.1` (same as gateway)

**Port forwarding not working:**
- Confirm container binds to `0.0.0.0` (not `127.0.0.1`) inside the guest
- Port forwards target `192.168.127.2:{guest_port}`, not localhost
- Check for port conflicts on the host side

**Socket path too long:**
- macOS limit is 104 bytes, Linux is 108 bytes
- `SocketShortener` handles this automatically
- If the temp directory itself has a long path, an explicit error is returned

## B.13 Data Path (End-to-End)

```mermaid
flowchart TB
    subgraph Inbound["Inbound: Host → Guest"]
        HA["Host App<br/>connects to localhost:8080"]
        HK["Host OS Kernel"]
        GVP_IN["gvproxy<br/>(Unix socket listener)"]
        PF["Port Forward Rule<br/>8080 → 80"]
        TAP_IN["TAP device<br/>(host side)"]
        SOCK_IN["Unix socket bridge"]
        KRUN_IN["libkrun<br/>virtio-net"]
        ETH_IN["Guest eth0<br/>192.168.127.2"]
        PROC_IN["Container :80"]
    end

    HA --> HK --> GVP_IN --> PF --> TAP_IN --> SOCK_IN --> KRUN_IN --> ETH_IN --> PROC_IN

    subgraph Outbound["Outbound: Guest → Internet"]
        PROC_OUT["Container<br/>curl https://api.example.com"]
        ETH_OUT["Guest eth0"]
        KRUN_OUT["libkrun<br/>virtio-net"]
        SOCK_OUT["Unix socket bridge"]
        GVP_OUT["gvproxy<br/>(userspace TCP/IP)"]
        MITM{"MITM<br/>intercept?"}
        DIRECT["Direct forward"]
        PROXY["MITM proxy<br/>(secret injection)"]
        INTERNET["Internet"]
    end

    PROC_OUT --> ETH_OUT --> KRUN_OUT --> SOCK_OUT --> GVP_OUT --> MITM
    MITM -->|"no secrets for host"| DIRECT --> INTERNET
    MITM -->|"secrets configured"| PROXY --> INTERNET
```

## B.14 Configuration Reference

### B.14.1 GvproxyConfig (Full JSON)

This is the JSON structure passed from Rust to Go via `gvproxy_create()`:

```json
{
  "socket_path": "/home/user/.boxlite/boxes/my-box/sockets/net.sock",
  "subnet": "192.168.127.0/24",
  "gateway_ip": "192.168.127.1",
  "gateway_mac": "5a:94:ef:e4:0c:dd",
  "guest_ip": "192.168.127.2",
  "host_ip": "192.168.127.254",
  "guest_mac": "5a:94:ef:e4:0c:ee",
  "mtu": 1500,
  "port_mappings": [
    { "host_port": 8080, "guest_port": 80 },
    { "host_port": 8443, "guest_port": 443 }
  ],
  "dns_zones": [
    {
      "name": "boxlite.internal.",
      "records": [{ "name": "host", "ip": "192.168.127.254" }],
      "default_ip": ""
    }
  ],
  "dns_search_domains": ["local"],
  "debug": false,
  "allow_net": ["api.openai.com", "*.github.com"],
  "secrets": [
    {
      "name": "openai",
      "hosts": ["api.openai.com"],
      "placeholder": "<BOXLITE_SECRET:openai>",
      "value": "sk-actual-key-value"
    }
  ],
  "ca_cert_pem": "-----BEGIN CERTIFICATE-----\n...",
  "ca_key_pem": "-----BEGIN PRIVATE KEY-----\n..."
}
```

### B.14.2 Environment Variables

| Variable | Purpose | Example |
|----------|---------|---------|
| `RUST_LOG` | Control log verbosity | `RUST_LOG=gvproxy=debug` |
| `BOXLITE_NET_CAPTURE_FILE` | Enable pcap packet capture | `/tmp/capture.pcap` |

## B.15 Source File Reference

| File | Purpose |
|------|---------|
| `src/boxlite/src/net/mod.rs` | `NetworkBackend` trait, `NetworkBackendFactory`, types |
| `src/boxlite/src/net/constants.rs` | IP, MAC, DNS, MTU constants |
| `src/boxlite/src/net/socket_path.rs` | `SocketShortener` for Unix `sun_path` limits |
| `src/boxlite/src/net/ca.rs` | MITM CA certificate generation (ECDSA P-256) |
| `src/boxlite/src/net/libslirp.rs` | Fallback `LibslirpBackend` |
| `src/boxlite/src/net/gvproxy/mod.rs` | `GvisorTapBackend` implementation |
| `src/boxlite/src/net/gvproxy/config.rs` | `GvproxyConfig`, `DnsZone`, `PortMapping` |
| `src/boxlite/src/net/gvproxy/instance.rs` | `GvproxyInstance` lifecycle + stats logging |
| `src/boxlite/src/net/gvproxy/ffi.rs` | Safe FFI wrappers |
| `src/boxlite/src/net/gvproxy/logging.rs` | Go-to-Rust log bridge |
| `src/boxlite/src/net/gvproxy/stats.rs` | `NetworkStats`, `TcpStats` |
| `src/boxlite/src/net/port.rs` | Windows TCP port allocation |
| `src/boxlite/src/vmm/krun/constants.rs` | virtio-net feature flags |
| `src/boxlite/src/vmm/krun/context.rs` | Engine network setup (`add_net_*`) |
| `src/boxlite/src/litebox/init/tasks/guest_init.rs` | Guest network init RPC |
| `src/guest/src/network.rs` | Guest-side `eth0` configuration (rtnetlink) |
| `src/deps/libgvproxy-sys/src/lib.rs` | Raw FFI declarations |
| `src/deps/libgvproxy-sys/gvproxy-bridge/main.go` | Go FFI exports, instance management |
| `src/deps/libgvproxy-sys/gvproxy-bridge/dns_filter.go` | DNS sinkhole |
| `src/deps/libgvproxy-sys/gvproxy-bridge/tcp_filter.go` | TCP allowlist |
| `src/deps/libgvproxy-sys/gvproxy-bridge/forked_tcp.go` | TCP forwarder with filtering |
| `src/deps/libgvproxy-sys/gvproxy-bridge/mitm_proxy.go` | HTTPS MITM + secret substitution |
| `src/deps/libgvproxy-sys/gvproxy-bridge/mitm_replacer.go` | Streaming placeholder replacement |
| `src/deps/libgvproxy-sys/gvproxy-bridge/mitm_websocket.go` | WebSocket through MITM |
| `src/deps/libgvproxy-sys/gvproxy-bridge/sni_peek.go` | TLS SNI extraction |
| `src/deps/libgvproxy-sys/gvproxy-bridge/stats.go` | Statistics collection |
