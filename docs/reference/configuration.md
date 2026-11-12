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
  `allow_net` rule of its own. Injection runs in front of the allowlist, and
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
- Exact IPv4: `"192.168.1.10"`
- IPv4 CIDR range: `"10.0.0.0/8"`

Create and runtime updates reject any other rule, such as `"example.com:443"`.

### `secrets`

Secrets the host proxy writes into a request header on outbound HTTPS requests.
The creator of the box decides which host and header receive a secret; code
inside the box cannot change that.

**Shape:**
- `name`: human-readable secret name
- `value`: real secret value
- `hosts`: required, at least one host; `*.example.com` matches one subdomain level
- `placeholder`: optional dummy value for the guest, defaults to `<BOXLITE_SECRET:{name}>`
- `headers`: required, non-empty map from header names to templates. Each template
  contains exactly one `{value}` and no other braces; all entries use this secret's value.
  Missing, null and empty maps are rejected by every SDK and create API, including
  Go nil/empty maps and C zero entries. No Authorization template is supplied automatically.

**Proxy behavior:**

| Request | Result |
| --- | --- |
| HTTPS to a listed host, with the configured header | Overwrites its value, including an empty value |
| HTTPS to a listed host, without the configured header | No injection |
| Any other host, or plain HTTP | No injection |
| Placeholder in another header, the query, or the body | Sent unchanged |

Header names match case-insensitively on the original request, before outbound
hop-by-hop cleanup. The value need not contain a placeholder.
Each present target header receives its rendered template. Substitution happens
once: braces inside the secret value are not interpreted.

| API | `hosts` | `headers` |
| --- | --- | --- |
| OpenAI | `api.openai.com` | `{"Authorization": "Bearer {value}"}` |
| Anthropic | `api.anthropic.com` | `{"x-api-key": "{value}"}` |
| GitHub | `api.github.com` | `{"Authorization": "Bearer {value}"}` |
| Gemini | `generativelanguage.googleapis.com` | `{"x-goog-api-key": "{value}"}` |
| Discord | `discord.com` | `{"Authorization": "Bot {value}"}` |

Stored header names, templates and rendered values receive the same validation
on creation, activation and import. Legacy host-conflict handling remains
separate. Restart stops a running box first, then starts it. If stored secret
headers are invalid, start rejects the configuration after the VM has stopped;
the stored data remains intact only if stop did not remove the box.

Pick the header the SDK in the box actually sends. If the configured header is
absent, no credential is injected and the upstream may return 401.

**Create rejects:**
- `hosts` empty, or holding an empty entry
- an empty `placeholder`
- a header name that is not a valid HTTP token, or is one of `Host`, `Connection`,
  `Proxy-Connection`, `Proxy-Authenticate`, `Proxy-Authorization`, `Keep-Alive`,
  `TE`, `Trailer`, `Upgrade`,
  `Content-Length`, `Transfer-Encoding`
- duplicate case-insensitive header names within one secret, or two secrets
  writing the same header on the same host; repeated hosts within one secret are deduplicated. Overlap between
  a wildcard and an exact host is not detected; the last secret wins.
- templates missing `{value}`, repeating it, or containing other braces
- ASCII control bytes 0–31 except HTAB (9), and DEL (127), in templates or rendered values; spaces and HTAB are allowed

Creation applies all these rules. Stored configurations remain readable as metadata.
Start of a new VM and import validate stored secret headers before
activation or installation. Running legacy boxes keep running until stopped;
reattaching to stop them does not validate headers.

Restart performs stop first. For boxes not removed on stop, rejected activation
leaves the box stopped with its stored data intact. Missing, null or empty headers
produce `secret "x" has no headers; recreate the box with headers`.
On a local runtime, `auto_delete > 0`, or legacy `auto_remove=true` when
`auto_delete` is unset, removes the box and its data on stop unless clone dependencies prevent deletion.
Restart then reports that the box disappeared without calling start.
Back up data before restarting such legacy boxes.

Other legacy header conflicts retain their existing last-writer behavior and warning.

Recovering a cloud box recreates it, so a stored secret that breaks these rules
fails validation before destroying the old box. Header names, templates, rendered
values, and conflicts are checked first, so invalid stored configuration keeps
the old box intact. Fix the secret, then retry.

**Not supported:**
- APIs that take the key in the query or body
- Automatic credential encoding and request signing such as AWS SigV4

**Migrating from placeholder substitution:** the proxy no longer searches requests
for placeholders. A placeholder in a header other than the configured one, the
query, or the body now reaches the upstream unchanged. Move those keys to a header
and declare it. To use Bearer authentication, explicitly set
`"headers": {"Authorization": "Bearer {value}"}`.
Requests without the configured header remain anonymous; any existing value,
including an empty value, triggers injection on a matching host.

**Notes:**
- The guest holds only the placeholder, exposed as `BOXLITE_SECRET_<NAME>`, so SDKs
  that require a key can start. The proxy never parses it.
- **Do not bind a secret to a host that echoes requests,** such as a debug or echo
  service. An upstream that returns the injected header hands the real value back
  to the box; the proxy does not scrub responses.
- Any process in the box can make authenticated requests to a listed host. The
  value is isolated; the right to use it is not.
- **A secret is an egress grant as well as a credential.** Every host this
  matches becomes reachable on port 443 without a rule of its own — declaring
  that a credential is used at a host already says the host must be reachable.
  A wildcard entry grants its subdomains the same way it matches them, one
  level deep. The grant is a by-name dial, so under a non-empty `allow_net` a
  host answering with a private, loopback or CGNAT address is refused unless an
  IP or CIDR rule covers that range. Nothing else opens: those hosts on port
  80, on any other port, or over UDP are still governed by `allow_net` alone.
- Injection is HTTPS-only. A plain-HTTP request carries no real value, which is
  the other reason port 80 is not opened here.
- Under `mode` `"disabled"` a secret does nothing: no network backend is
  created, so nothing is injected and no host becomes reachable. The
  placeholder environment variable is still injected into the guest.
- C SDK users pass parallel header-name and template arrays to
  `boxlite_options_add_secret_with_headers()` with at least one entry.
  The old `boxlite_options_add_secret()` symbol remains available for ABI compatibility,
  but its headerless secret is rejected when creating a box.

**Required-headers upgrade notice:** local SDK and `boxlite serve` users must recreate
existing boxes that have secrets, supplying explicit headers. Metadata queries still
work. Restart stops a running legacy box first; if stop retains the box, start rejects missing headers and its stored data remains intact.
Recreation with explicit headers is required.

Back up data before restarting legacy boxes configured for removal on stop.
Local `auto_delete > 0`, or legacy `auto_remove=true` when `auto_delete` is unset,
deletes the box and its data unless clone dependencies prevent deletion.
If deleted, restart reports that the box disappeared instead of starting it.

Import still rejects invalid headers before changing stored-data state.
Running legacy boxes keep running until stopped. The cloud database was confirmed to contain no such boxes;
local SQLite stores were not checked.

The development-only singular `header` field is not migrated. Recreate those
boxes with `headers`, for example `{"X-Key": "{value}"}`. For Bearer authentication,
use `{"Authorization": "Bearer {value}"}`. An unconverted singular field does not
satisfy the required-headers contract.

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

### `cpus: float`

CPU allocation, default `1`, from `0.125` to `16` with the bundled kernel, in increments of `0.001`.
Integers, including `2.0`, retain existing vCPU behavior without adding a bandwidth quota.
Fractional allocations use `ceil(cpus)` guest vCPUs and a Linux aggregate CPU-time quota.

```python
cpus=0.5  # 1 guest vCPU, half a CPU of aggregate time
cpus=1.5  # 2 guest vCPUs, 1.5 CPUs of aggregate time
cpus=2    # 2 guest vCPUs, no additional bandwidth quota
```

Fractional values require a Linux execution host and the jailer; enforcement also needs writable cgroup v2 CPU quotas.
Local macOS execution rejects them; macOS REST clients can request them from a supporting Linux server.
A quota-write failure is logged at error level and does not prevent startup; like best-effort cgroup membership, it can leave a running Box without enforcement.
Information queries return the configured allocation.
Configuration is fixed at creation; see [fractional CPUs](../guides/resource-limits.md#fractional-cpus-linux) for SDK mappings, reuse, REST confirmation, and archive compatibility.

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
  `box.network.tunnel(target, options)`; each returned tunnel is one-shot.
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

### `image_registry_proxy`

Proxy for image pulls, with `http_proxy`, `https_proxy`, and `no_proxy` fields. Unset, pulls read the proxy environment variables. Set, it replaces all of them for pulls. Invalid settings fail runtime creation. Available in Rust `BoxliteOptions` and the CLI `--config` file.

**Default:** unset

See [Pull proxy](../guides/image-registry-configuration.md#pull-proxy) for the full behavior.

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
