# BoxLite Go SDK

Go SDK for BoxLite — an embeddable virtual machine runtime for secure, isolated code execution.

## Install

```bash
go get github.com/boxlite-ai/boxlite/sdks/go
go run github.com/boxlite-ai/boxlite/sdks/go/cmd/setup
```

Requires Go 1.24+ with CGO enabled. The setup step downloads the prebuilt native library and header into the module directory in your Go module cache (one-time). Set `GITHUB_TOKEN` to avoid API rate limits.

## Usage

```go
package main

import (
	"context"
	"fmt"
	"log"

	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
)

func main() {
	rt, err := boxlite.NewRuntime(
		boxlite.WithImageRegistry(boxlite.ImageRegistry{
			Host: "registry.example.com",
			Auth: boxlite.ImageRegistryAuth{
				Username: "user",
				Password: "password",
			},
		}),
	)
	if err != nil {
		log.Fatal(err)
	}
	defer rt.Close()

	ctx := context.Background()
	box, err := rt.Create(ctx, "alpine:latest",
		boxlite.WithName("my-box"),
		boxlite.WithCPUs(1),
		boxlite.WithMemory(512),
		boxlite.WithNetwork(boxlite.NetworkSpec{
			Outbound: boxlite.OutboundNetworkSpec{
				Mode:     boxlite.NetworkModeEnabled,
				AllowNet: []string{"api.openai.com"},
			},
		}),
		boxlite.WithSecret(boxlite.Secret{
			Name:  "openai",
			Value: "sk-...",
			Hosts: []string{"api.openai.com"},
		}),
	)
	if err != nil {
		log.Fatal(err)
	}

	if err := box.Start(ctx); err != nil {
		log.Fatal(err)
	}

	fmt.Println("Box started successfully!")
}
```

### Archive Export and Import

```go
archivePath, err := box.Export(ctx, "/var/lib/my-app/archives")
if err != nil {
	log.Fatal(err)
}

// An empty name uses the same unnamed-box behavior as Create without
// WithName. The imported box receives a new ID and starts stopped.
restored, err := rt.Import(ctx, archivePath, "")
if err != nil {
	log.Fatal(err)
}
defer restored.Close()
```

A local runtime treats the archive as trusted because local applications own
both the runtime and archive. A REST runtime uploads the file and relies on the
server's untrusted-upload policy.

Export and Import never delete the archive. The caller owns its retention and
must explicitly remove it when it is no longer needed.

### Runtime Image Management

`rt.Images()` holds the images a runtime can boot from: the local cache on a
runtime from `NewRuntime`, the server's catalog on one from `NewRest`. The same
code runs against either.

```go
ctx := context.Background()
images, err := rt.Images()
if err != nil {
	log.Fatal(err)
}
defer images.Close()

pull, err := images.Pull(ctx, "alpine:latest")
if err != nil {
	log.Fatal(err)
}
fmt.Println(pull.Reference, pull.ConfigDigest, pull.LayerCount)

cached, err := images.List(ctx)
if err != nil {
	log.Fatal(err)
}
for _, image := range cached {
	fmt.Println(image.Repository, image.Tag, image.ID)
}

detail, err := images.Get(ctx, "docker.io/library/alpine")
if err != nil {
	log.Fatal(err)
}
for _, version := range detail.Versions {
	fmt.Println(detail.Name, version.Digest, version.RecordedAt)
}
if err := images.Remove(ctx, "docker.io/library/alpine"); err != nil {
	log.Fatal(err)
}
```

| Method | Local runtime | REST runtime |
|--------|---------------|--------------|
| `Pull` | Pulls into the cache | `ErrUnsupported`: creating a box pulls |
| `List` | One row per cached reference | One row per catalog tag |
| `Get` | The cache entries under the name | The catalog entry with its versions |
| `Remove` | Forgets the name; layers stay | Removes the catalog entry; `ErrInvalidState` while a box can boot from it |
| `Usage` | `ErrUnsupported` | `ImageUsage{Count, Limit, KnownBytes}` |

`Get` and `Remove` take an image name such as `"docker.io/library/alpine"`. A
reference with a tag or digest fails with `ErrInvalidArgument`, since a remove
takes every tag of the name; a name the runtime does not hold fails with
`ErrNotFound`. `ImageDetail.Versions` is newest first, and
`ImageVersion.SizeBytes` is nil when the size is unknown. Locally, a box built
from a removed image reads the image's configuration from the registry when it
next starts.

## Box Options

- `WithNetwork(boxlite.NetworkSpec{Outbound: boxlite.OutboundNetworkSpec{Mode: boxlite.NetworkModeEnabled, AllowNet: []string{"api.openai.com"}}})` restricts outbound traffic while keeping networking enabled.
- `WithNetwork(boxlite.NetworkSpec{Outbound: boxlite.OutboundNetworkSpec{Mode: boxlite.NetworkModeDisabled}})` disables the guest network interface entirely.
- `WithNetwork(boxlite.NetworkSpec{Inbound: boxlite.InboundNetworkSpec{Mode: boxlite.NetworkModeEnabled}})` makes the services the box exposes publicly reachable. Inbound is private by default, including when `Inbound.Mode` is unset. The two directions are independent.
- The deprecated flat fields `NetworkSpec{Mode, AllowNet}` still configure the outbound direction. Setting them together with `Outbound` is rejected when the options are built. `NetworkInfo.Mode` and `NetworkInfo.AllowNet` likewise remain readable as views onto `NetworkInfo.Outbound`.
- `WithPort(boxlite.PortSpec{Guest: 3000})` publishes TCP locally on an OS-selected host port; after checking `BoxInfo.Network != nil`, read the concrete binding from `Network.PublishedPorts`.
- A nil `PublishedPorts` slice means the current handle does not know the bindings; a non-nil empty slice means there are no active publications. `Box.Info`, `Runtime.GetInfo`, and `Runtime.ListInfo` use callback-backed runtime operations and honor context cancellation.
- `WithSecret(boxlite.Secret{...})` configures host-side HTTPS secret substitution; `Placeholder` defaults to `<BOXLITE_SECRET:{Name}>`.
- Container capabilities live under advanced options:

  ```go
  advanced, err := boxlite.NewAdvancedBoxOptions()
  if err != nil { log.Fatal(err) }
  defer advanced.Close()
  if err := advanced.SetCapabilities(boxlite.ContainerCapabilities{
      Add: []string{"NET_ADMIN"},
      Drop: []string{"NET_RAW"},
  }); err != nil { log.Fatal(err) }
  box, err := runtime.Create(ctx, "alpine:latest", boxlite.WithAdvancedOptions(advanced))
  ```

Port publication is local-only. Remote runtimes reject it with guidance to use
the existing network tunnel API. Each tunnel handle is one-shot.
OCI `EXPOSE` metadata does not publish ports.

## Service Tunnels

The same route workflow works with local and remote runtimes:

- `box.Network() (*Network, error)` returns box-scoped network operations.
- `network.Tunnel(ctx, port) (*BoxTunnel, error)` prepares a one-shot tunnel.
- `TCPListenAddress(host, port)` and `UnixListenAddress(path)` return validated
  standard `net.Addr` values for `tunnel.Forward(ctx, addr)`. The returned
  `TunnelForwarder` has `Addr() net.Addr`, `Wait(ctx) error`, and repeatable
  `Close() error`; canceling a wait context does not close the listener.
- `tunnel.URI() (string, error)` returns the public URL of a remotely served tunnel, or an empty string for a local one.
- `tunnel.Connect(ctx) (net.Conn, error)` consumes the prepared connection.

Choose `Connect` or `Forward`; a forwarder prepares fresh tunnels for later
clients. This differs from `WithPort`, which creates a persistent,
local-only host listener that accepts repeated connections.

## Development

Build from source (requires Rust toolchain):

```bash
# From the project root
make dev:go

# Run tests
cd sdks/go && go test -tags boxlite_dev -v ./...
```

## License

Apache-2.0
