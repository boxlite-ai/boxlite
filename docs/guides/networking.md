# Configuring networking

BoxLite provides full internet access and port forwarding through gvproxy.

## Network modes

BoxLite uses gvproxy for NAT networking by default. All boxes can:
- Access the internet
- Resolve DNS
- Make outbound connections

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
`box.network.tunnel(port)` and open byte streams with `connect()`. A tunnel
can be consumed by `connect()` or by `forward()` to bind a local listener.
Remote CLI users can run `boxlite network tunnel BOX PORT` to obtain the public
service URL.

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
