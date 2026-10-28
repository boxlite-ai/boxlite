## TL;DR

Create boxes with a network policy, then replace either direction through `box.network` or the CLI.

## Details

### Updating a running box

Each `update_*` method replaces one complete direction; it never patches. The other direction is unchanged.
Enabled outbound with an empty allowlist removes restrictions; disabled stops
network traffic and replaces the list with an empty list. Omitted outbound rules
use the default empty list; update methods do not merge or restore earlier rules.
An inbound allowlist is unsupported.

```python
await box.network.update_inbound(boxlite.InboundNetworkSpec(mode="enabled"))
await box.network.update_outbound(
    boxlite.OutboundNetworkSpec(mode="enabled", allow_net=["*.example.com"])
)
await box.network.update_outbound(boxlite.OutboundNetworkSpec(mode="enabled"))  # default empty list
```

Python's synchronous API uses the same methods without `await`. Node uses
`box.network.updateInbound(spec)` and `updateOutbound(spec)`, with `allowNet`.
Rust uses `box.network().update_outbound(OutboundNetworkConfig { ... }).await`.

| SDK | Inbound parameter | Outbound parameter | Empty outbound list |
| --- | --- | --- | --- |
| Python | `InboundNetworkSpec` | `OutboundNetworkSpec` | Omit `allow_net` or pass `[]` |
| Node | `InboundNetworkSpec` | `OutboundNetworkSpec` | Omit `allowNet` or pass `[]` |
| Rust | `InboundNetworkConfig` | `OutboundNetworkConfig` | `allow_net: vec![]` |
| Go | `InboundNetworkSpec` | `OutboundNetworkSpec` | `AllowNet: nil` or `[]string{}` |
| C/REST | JSON direction object | JSON direction object | Omit `allow_net` or pass `[]` |

Rust keeps `allow_net: Vec<String>` in `OutboundNetworkConfig`.
To re-enable with restrictions, supply the complete desired list again:

```rust
box_handle.network().update_outbound(OutboundNetworkConfig {
    mode: NetworkMode::Enabled,
    allow_net: vec!["example.com".into()],
}).await?;
```

```go
network, err := box.Network()
if err != nil { return err }
defer network.Close()
err = network.UpdateOutbound(ctx, boxlite.OutboundNetworkSpec{
    Mode: boxlite.NetworkModeEnabled, AllowNet: []string{"example.com"},
})
```

The C SDK exposes blocking `boxlite_network_update_inbound` and
`boxlite_network_update_outbound` on `CBoxNetworkHandle`. Pass a JSON direction
object such as `{"mode":"enabled","allow_net":["example.com"]}`.

```bash
boxlite network inbound mybox enabled
boxlite network outbound mybox enabled --allow-net '*.example.com' --allow-net 10.0.0.0/8
boxlite network outbound mybox enabled  # default empty list: unrestricted
boxlite network outbound mybox disabled
boxlite inspect mybox
```

| Contract | Behavior |
| --- | --- |
| Replacement | No implicit append; repeat `--allow-net` once per rule. |
| Default list | Omit `--allow-net` to replace with an empty list. |
| Rules | Exact hostname, wildcard hostname, IPv4 or IPv4 CIDR; no CSV. |
| Invalid combinations | Reject inbound allowlists, disabled outbound with any `--allow-net`, and empty rules such as `''`. |
| Local/serve outbound | Requires a running box created with networking enabled. |
| Local inbound | Unsupported; inbound visibility is enforced by the cloud proxy. |
| No NIC, old backend | Explicit error; no implicit start, restart or hot-plug. |
| Allowlist changes | New TCP/UDP flows use the new policy; existing flows retain theirs. |
| Runtime disabled | Suspends the NIC, including DNS and inbound traffic; control and exec remain available. |
| Re-enable | Uses the supplied complete policy on the existing NIC. Existing connections may have timed out. |
| Persistence | Successful outbound updates survive reattachment and normal stop/start. |
| Clone/export | Copies inherit the latest persisted outbound policy. |
| Inbound timing | Cloud proxy cache expiry governs new connections; existing connections stay open. |

REST creation and outbound replacement share the same combination check:
`{"mode":"disabled","allow_net":["example.com"]}` returns HTTP 400.
Creation rejects it before allocating a box, including the deprecated flat
network shape. Disabled mode accepts an omitted allowlist or `[]`; rules are
never silently discarded. Internal creation also checks the effective mode
after applying the organization's default. Runner create, recovery and update
requests enforce the same rule. Recovery rejects contradictory old policy
before destroying the existing box; it does not rewrite stored rules.

An update returns after application and persistence. On persistence failure,
BoxLite attempts to restore the previous policy. A timeout, lost response, or
failed rollback can leave live and stored state different: retry the complete
policy. `inspect` reports the last persisted policy, not an independent traffic probe.

Persisting the replacement does not retain a separate list for later re-enabling.
Normal restart uses the latest saved policy. Defaults here mean an empty outbound
allowlist, not a lookup of earlier, organization, or system configuration.

### Creating with an allowlist

Creation uses the same repeated-rule syntax:

```bash
boxlite create --name mybox --allow-net '10.0.0.0/16' --allow-net 'openai.com' alpine:latest
boxlite start mybox
```

`--allow-net` implies enabled networking. Creation defaults remain enabled
outbound with an empty list and disabled inbound. Creation with `--network
disabled` cannot include rules because it provisions no NIC.

Creation and updates accept the same rules: hostnames, `*.` wildcard hostnames,
IPv4 addresses and IPv4 CIDRs, with surrounding spaces trimmed. Both reject
anything else, such as `''`, `example.com:443` or `a.com,b.com`, so every saved
list can be re-sent as an update. Start and import do not recheck rules, so boxes and archives saved by
older releases keep working; replace such a list with a valid one before
updating it.

### Update paths

| Path | Application and persistence |
| --- | --- |
| Local outbound | SDK/CLI → Rust validation → BoxImpl → gvproxy control socket → network handlers/NIC → local persistence |
| Serve outbound | REST PUT → local outbound path |
| Cloud outbound | REST PUT → authorization and row lock → runner → Go/C/Rust local path → cloud persistence |
| Cloud inbound | REST PUT → saved inbound mode → proxy access checks |

The previous policy is read for rollback if persistence fails; it is not merged
into the requested replacement.

Existing secret-host exceptions and DNS behavior under an enabled allowlist
remain unchanged. Hostname rules inspect HTTP Host/TLS SNI; UDP needs an IP/CIDR rule.

## Network modes

Enabled networking uses gvproxy for NAT and DNS. A box created with outbound
`disabled` has no NIC or gvproxy. While that box is running, setting outbound to
`enabled` returns `Unsupported`.

Only boxes created with a NIC can restore traffic after runtime disabling.
Runtime `disabled` pauses the existing NIC without removing it.

## Port publication

Explicitly publish guest ports when ordinary host applications need a local TCP
listener. The local runtime owns the listener for the lifetime of the running
box and accepts repeated connections.

**Basic Port Publication:**

```python
import boxlite

options = boxlite.BoxOptions(
    image="python:slim",
    ports=[
        (8080, 80, "tcp"),      # Host 8080 → Guest 80 (HTTP)
        (8443, 443, "tcp"),     # Host 8443 → Guest 443 (HTTPS)
    ]
)

runtime = boxlite.Boxlite.default()
box = await runtime.create(options)
```

**Multiple Ports:**

```python
ports=[
    (8080, 80, "tcp"),      # HTTP
    (8443, 443, "tcp"),     # HTTPS
    (5432, 5432, "tcp"),    # PostgreSQL
    (6379, 6379, "tcp"),    # Redis
    {"guest_port": 3000},   # Automatic host port
]
```

**Custom Port Mapping:**

```python
# Map host port 3000 to guest port 8000
ports=[(3000, 8000, "tcp")]
```

Port publication is available only with the local runtime and supports TCP. It
is appropriate for browsers, database clients, and other programs that expect a
normal host address.

For SDK code that must work with local and remote runtimes, use
`box.network.tunnel(target, options)` and open byte streams with `connect()`. A tunnel
can be consumed by `connect()` or by `forward()` to bind a local listener.
Remote CLI users can run `boxlite network tunnel BOX PORT` to obtain the
service URL. Inbound access is disabled by default; enable it with
`--inbound enabled` at create time, or later through
`PUT /{prefix}/boxes/{box_id}/network/inbound` or the **Inbound access** switch
in the dashboard's box network section. `boxlite inspect BOX`,
`box.info().network`, and the dashboard's `outbound` and `inbound` rows report
both directions of a remote box's policy. With inbound access enabled, the
dashboard's **get url** returns the same URL as `boxlite network tunnel`.

Image `EXPOSE` declarations are metadata only and never create host listeners.

## Testing connectivity

**From Host to Box:**

```python
import asyncio
import boxlite
import requests

async def test_connectivity():
    runtime = boxlite.Boxlite.default()
    box = await runtime.create(boxlite.BoxOptions(
        image="python:slim",
        ports=[(8080, 8000, "tcp")],
    ))
    # Box.exec returns while the server keeps running
    server = await box.exec("python", ["-u", "-m", "http.server", "8000"])
    async for line in server.stdout():  # wait until it is listening
        if "Serving HTTP" in line:
            break

    # Test from host
    response = requests.get("http://localhost:8080")
    print(f"Status: {response.status_code}")

    await server.kill()
    await box.stop()

asyncio.run(test_connectivity())
```

**From Box to Internet:**

```python
async with boxlite.SimpleBox(image="alpine:latest") as box:
    # Test DNS
    result = await box.exec("nslookup", "google.com")
    print(result.stdout)

    # Test HTTP
    result = await box.exec("wget", "-O-", "https://api.github.com/zen")
    print(result.stdout)
```

**From Box to Host Loopback:**

```bash
# On the host, start a service bound to loopback
python3 -m http.server 8081 --bind 127.0.0.1
```

```python
async with boxlite.SimpleBox(image="alpine:latest") as box:
    result = await box.exec(
        "wget",
        "-O-",
        "http://host.boxlite.internal:8081",
    )
    print(result.stdout)
```

`host.boxlite.internal` is a built-in BoxLite hostname that resolves to the
host loopback proxy address. It is not a Docker compatibility alias.
Security note: with an empty `allow_net`, any service bound to host loopback is
reachable from inside the box. A non-empty `allow_net` must list
`"192.168.127.254"`, or a CIDR covering it, for the alias to be reachable.

## Network metrics

Monitor network usage:

```python
box = await runtime.create(boxlite.BoxOptions(image="alpine"))
metrics = await box.metrics()

print(f"Bytes sent: {metrics.network_bytes_sent}")
print(f"Bytes received: {metrics.network_bytes_received}")
```

## Troubleshooting networking

**Problem:** Port forward not working

**Solutions:**
```bash
# Check if port is in use
lsof -i :8080

# Stop conflicting process or use different port
```

**Problem:** Cannot access internet from box

**Solutions:**
```bash
# gvproxy runs inside each box's shim process; verify the shim is running
ps aux | grep boxlite-shim

# Check DNS resolution
# (run inside box)
nslookup google.com
```
