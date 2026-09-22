# Configuration

## BoxOptions parameters

Complete reference for box configuration options.

### `image: String`

OCI image URI to use for the box rootfs.

**Format:** `[registry/]repository[:tag]`

**Default:** `"python:slim"` (for Python SDK convenience wrappers)

**Examples:**
```python
# Docker Hub (default registry)
image="python:3.11-slim"
image="alpine:latest"
image="ubuntu:22.04"

# GitHub Container Registry
image="ghcr.io/owner/repo:tag"

# Amazon ECR
image="123456.dkr.ecr.us-east-1.amazonaws.com/repo:tag"

# Google Container Registry
image="gcr.io/project/image:tag"
```

**Notes:**
- Images are pulled on first use and cached in `~/.boxlite/images/`
- Layer-level caching for fast subsequent starts
- Authentication: Use registry-specific auth (Docker credentials, etc.)

### `network`

Structured network configuration for outbound connectivity.

**Default:** omitted, which behaves like:

```json
{
  "mode": "enabled",
  "allow_net": []
}
```

**Shape:**
- `mode`: `"enabled"` or `"disabled"`
- `allow_net`: optional outbound allowlist used only when `mode="enabled"`

**Notes:**
- `"enabled"` gives the guest outbound connectivity.
- `"disabled"` removes the guest network interface entirely.
- Empty or omitted `allow_net` means full outbound access.
- A non-empty `allow_net` restricts both TCP and UDP egress. IP and CIDR rules
  match the destination address and apply to both. Hostname rules are enforced
  by inspecting TLS SNI / HTTP Host, which only TCP carries, so an `allow_net`
  holding **only** hostnames denies all UDP egress — otherwise a guest could
  sidestep the rule by addressing an allowed name's IP directly. QUIC/HTTP3 to
  such a host falls back to TCP; add the IP or CIDR to keep UDP open.
- A hostname rule authorizes the **name**, not an address. Once the SNI / Host
  matches, the gateway resolves the name itself through the host resolver and
  connects to its current address; the address the guest connected to is
  ignored. A host that changes IP while the box runs stays reachable, each
  subdomain under a wildcard resolves to its own address, and a guest that
  hard-codes another IP with an allowed SNI still reaches the allowed host. A
  name that resolves to a private, loopback or CGNAT address is not connected
  to unless an IP or CIDR rule also lists that range. Link-local (metadata,
  `169.254.0.0/16`) is refused outright on both paths: no rule re-admits it,
  by name or by address. The box's own subnet is refused only as a resolved
  candidate, so that a name can never route back into the virtual network — a
  guest that addresses `192.168.127.254` itself still reaches it under an IP
  or CIDR rule covering it, as `host.boxlite.internal` below describes.
- **DNS inside the box is not restricted.** `allow_net` is a connection-layer
  control: `/etc/resolv.conf` points at the gateway `192.168.127.1`, which
  forwards every query, listed name or not, to the host's resolver. A denied
  destination therefore resolves to its real address and fails when the guest
  **connects**, not when it looks the name up. A denied name previously
  resolved to `0.0.0.0`, so code that detected the block by inspecting a
  lookup result must check for a failed connection instead.
- A host named by `secrets` below is reachable on port 443 without an
  `allow_net` rule of its own. Substitution runs in front of the allowlist, and
  the connection is dialed by name like any hostname rule, so the guest cannot
  steer it elsewhere by choosing an address. Under a non-empty `allow_net` that
  dial also refuses an answer in a private, loopback or CGNAT range unless an
  IP or CIDR rule covers it; the link-local and box-subnet refusals above apply
  either way. Only 443 is covered: plain HTTP, any other port, and UDP to that
  same host still need a rule. Under `"disabled"` a secret grants nothing,
  since the guest has no network interface at all.
- The gateway's DNS resolver and DHCP are internal services and stay reachable
  regardless of `allow_net`.
- `host.boxlite.internal` is a built-in hostname that resolves to
  `192.168.127.254` and reaches host loopback services. The DNS record is
  always served, but egress to that address is governed by `allow_net`: add
  `"192.168.127.254"`, or a CIDR covering it, to reach it under a non-empty
  allowlist.
- Security: `allow_net` is not the only egress gate — declaring a secret for a
  host opens port 443 to it, as above. With an empty or omitted `allow_net`,
  any service bound to host loopback is reachable from inside the box via
  `host.boxlite.internal` or `192.168.127.254`; allowing that address opens all
  of them. And `allow_net` bounds where the guest can **connect**, not what it
  can look up: every query it makes reaches the host's resolver, denied names
  included, so a query name is a channel out of the box. Earlier versions
  answered denied names `0.0.0.0` locally, which narrowed that channel for A
  queries but never closed it, since other record types were forwarded
  regardless. Treat `allow_net` as a routing control, not a containment
  boundary.

**Supported patterns:**
- Exact hostname: `"api.openai.com"`
- Wildcard hostname: `"*.example.com"`
- Exact IP: `"192.168.1.10"`
- CIDR range: `"10.0.0.0/8"`

### `secrets`

Host-side secret substitution rules for outbound HTTPS requests.

**Shape:**
- `name`: human-readable secret name
- `value`: real secret value
- `hosts`: matching hosts for substitution
- `placeholder`: optional guest-visible token, defaults to `<BOXLITE_SECRET:{name}>`

**Notes:**
- The guest sees only the placeholder, never the real secret value.
- The placeholder is also exposed as `BOXLITE_SECRET_<NAME>` inside the guest.
- **A secret is an egress grant as well as a credential.** Every host this
  matches becomes reachable on port 443 without a rule of its own — declaring
  that a credential is used at a host already says the host must be reachable.
  A wildcard entry grants its subdomains the same way it matches them, one
  level deep. The grant is a by-name dial, so under a non-empty `allow_net` a
  host answering with a private, loopback or CGNAT address is refused unless an
  IP or CIDR rule covers that range. Nothing else opens: those hosts on port
  80, on any other port, or over UDP are still governed by `allow_net` alone.
- Substitution is HTTPS-only. A plain-HTTP request would carry the placeholder
  rather than the real value, which is the other reason port 80 is not opened
  here.
- Under `mode` `"disabled"` a secret does nothing: no network backend is
  created, so nothing is substituted and no host becomes reachable. The
  placeholder environment variable is still injected into the guest.
- C SDK users configure secrets with `boxlite_options_add_secret()`.

### `advanced.capabilities`

Linux capability overrides for the container's init and all later exec
processes. Both lists default to empty, preserving BoxLite's Docker-compatible
14-capability baseline.

- Names are case-insensitive and accept either `NET_ADMIN` or `CAP_NET_ADMIN`.
- `ALL` is supported in either list.
- Without `ALL`, drops are applied to the baseline before explicit additions,
  so the same specifically named capability in both lists remains enabled.
- With `add=["ALL"]`, explicit drops win, matching Docker.
- Use `drop=["ALL"]` with explicit additions to construct a minimal set.
- Malformed names are rejected at the API boundary. A well-formed name that the
  bundled guest runtime does not support is rejected during container initialization.
- A remote client and the host both check support before creating a box; a
  custom policy is rejected rather than ignored when either side is too old.
- The resolved set is applied to OCI bounding, effective, and permitted sets.
  Inheritable and ambient capabilities stay unset; they are not implied by `add`.

### `cpus: int`

Number of CPU cores allocated to the box.

**Default:** 1

**Range:** 1 to host CPU count

**Example:**
```python
cpus=2  # 2 CPU cores
cpus=4  # 4 CPU cores
```

**Notes:**
- CPU scheduling is proportional (shares-based)
- Does not reserve physical cores, just scheduling weight
- Monitor actual usage with `box.metrics().cpu_time_ms`

### `memory_mib: int`

Memory limit in mebibytes (MiB).

**Default:** 512

**Range:** 128 to 65536 (64 GiB)

**Example:**
```python
memory_mib=1024   # 1 GB
memory_mib=2048   # 2 GB
memory_mib=4096   # 4 GB
```

**Notes:**
- 1 MiB = 1024 KiB = 1,048,576 bytes
- Minimum 128 MiB required for most images
- Out of memory kills the box process
- Monitor with `box.metrics().memory_usage_bytes`

### `disk_size_gb: int | None`

Size of the box's container disk, a copy-on-write QCOW2 image. The disk is never smaller than the
image.

**Default:** `None` (the image's size)

**Range:** 1 to 1024 (1 TB)

**Example:**
```python
disk_size_gb=None   # Image size (default)
disk_size_gb=10     # At least 10 GB
disk_size_gb=100    # At least 100 GB
```

**Notes:**
- Disk persists across stop/restart only when the box is kept after stop (`auto_delete=0`)
- Stored at `~/.boxlite/boxes/{box-id}/disks/disk.qcow2`
- Copy-on-write (thin provisioned)
- Deleted when box is removed

### `working_dir: str`

Working directory for command execution inside the box.

**Default:** `"/root"`

**Example:**
```python
working_dir="/app"
working_dir="/home/user/project"
```

**Notes:**
- Directory must exist in the container image
- Commands execute with this as `$PWD`

### `env: List[Tuple[str, str]]`

Environment variables as (key, value) pairs.

**Default:** `[]` (inherit from image)

**Example:**
```python
env=[
    ("DATABASE_URL", "postgresql://localhost/db"),
    ("API_KEY", "secret"),
    ("DEBUG", "true"),
    ("PATH", "/custom/bin:/usr/bin:/bin"),  # Override PATH
]
```

**Notes:**
- Variables are appended to image environment
- Use to override image defaults (e.g., `PATH`)
- Sensitive values (API keys, passwords) are visible in box metadata

### `volumes: List[Tuple | Dict]`

Volume mounts. A tuple is always a host bind; a dict takes either
`managed_volume` (a volume's id or name) or `host_path`, never both.

**Format:** `(host_path, guest_path[, read_only])` - `read_only` is a bool, default `False`.

**Default:** `[]` (no mounts)

**Example:**
```python
volumes=[
    # Read-only mount (data input)
    ("/host/config", "/etc/app/config", True),

    # Read-write mount (data output)
    ("/host/data", "/mnt/data", False),

    # Home directory mount
    (os.path.expanduser("~/Documents"), "/mnt/docs", True),
]
```

**Notes:**
- Uses virtiofs for high-performance file sharing
- Host path must exist before box creation
- Guest path is created automatically if missing
- Changes to `rw` mounts are visible on host immediately

### `ports: List[Tuple[int, int, str]]`

Port forwarding as (host_port, guest_port, protocol) tuples.

**Format:** `(host_port, guest_port, "tcp")`, or a dictionary with
`guest_port` and no `host_port` to request an automatic host port.

**Default:** `[]` (no port forwarding)

**Example:**
```python
ports=[
    (8080, 80, "tcp"),      # HTTP
    (8443, 443, "tcp"),     # HTTPS
    (5432, 5432, "tcp"),    # PostgreSQL
    (3000, 8000, "tcp"),    # Custom mapping
    {"guest_port": 3000},   # OS-selected host port
]
```

**Notes:**
- Uses gvproxy for NAT port mapping
- Host port must be available (not in use)
- Fixed host ports must be unique and available
- TCP is supported; UDP is rejected
- Port publication is local-only and owns a listener that accepts repeated
  connections. For portable local/remote SDK code, use
  `box.network.tunnel(port)`; each returned tunnel is one-shot.
- OCI `EXPOSE` is metadata and does not publish a host port.
- Port mappings are only for host → box traffic. Use
  `host.boxlite.internal:<port>` for box → host loopback traffic.

### `auto_delete: int | None`

Seconds after a successful stop before the box is deleted.

**Default:** `None`, which keeps the runtime's default: `auto_remove` on a local runtime, the
server's policy on a REST runtime.

**Example:**
```python
auto_delete=0     # Keep the box after stop
auto_delete=3600  # REST runtime: delete an hour after stop
```

**Notes:**
- `0`: the box persists after stop, and `runtime.get(box_id)` returns it
- Above `0`: a local runtime has no sweeper, so it deletes the box at stop
- Manual cleanup: `await runtime.remove(box_id)`

### `auto_remove: bool`

Deprecated: use `auto_delete`, which takes precedence when set. `True`, the default, removes the box
when it stops on a local runtime; REST runtimes do not send it and keep the server's policy.

## Runtime options

### `home_dir: str`

Base directory for BoxLite runtime data.

**Default:** `~/.boxlite`

**Override:** Set `BOXLITE_HOME` environment variable

**Structure:** see [File formats](file-formats.md#home-directory).

**Example:**
```python
# Custom home directory
runtime = boxlite.Boxlite(boxlite.Options(home_dir="/custom/path"))
```

## Environment variables

### `BOXLITE_HOME`

Override default runtime home directory.

**Default:** `~/.boxlite`

**Example:**
```bash
export BOXLITE_HOME=/custom/boxlite
python script.py
```

### `RUST_LOG`

Enable debug logging for troubleshooting.

**Levels:** `trace`, `debug`, `info`, `warn`, `error`

**Example:**
```bash
# Debug logging
RUST_LOG=debug python script.py

# Trace logging (very verbose)
RUST_LOG=trace python script.py

# Module-specific logging
RUST_LOG=boxlite::runtime=debug python script.py
```

### `BOXLITE_TMPDIR`

Override temporary directory for BoxLite operations.

**Default:** System temp directory (`/tmp` on Linux/macOS)

**Example:**
```bash
export BOXLITE_TMPDIR=/custom/tmp
python script.py
```

### `BOXLITE_MAX_LAYER_DECOMPRESSED_SIZE`

Cap on total decompressed bytes written while extracting OCI image layers.
A single extractor used for a whole image enforces this as a per-image cap;
per-layer extraction enforces it per layer. Exceeding the cap aborts the
pull with a `resource_exhausted` error (HTTP 429).

**Default:** `21474836480` (20 GiB)

**Example:**
```bash
# Allow larger images (e.g. ML images with huge layers)
export BOXLITE_MAX_LAYER_DECOMPRESSED_SIZE=53687091200
boxlite pull my-image:latest
```
