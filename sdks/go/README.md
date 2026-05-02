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
			Mode:     boxlite.NetworkModeEnabled,
			AllowNet: []string{"api.openai.com"},
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

### Runtime Image Management

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
```

## Box Options

- `WithNetwork(boxlite.NetworkSpec{Mode: boxlite.NetworkModeEnabled, AllowNet: []string{"api.openai.com"}})` restricts outbound traffic while keeping networking enabled.
- `WithNetwork(boxlite.NetworkSpec{Mode: boxlite.NetworkModeDisabled})` disables the guest network interface entirely.
- `WithSecret(boxlite.Secret{...})` configures host-side HTTP(S) secret substitution; `Placeholder` defaults to `<BOXLITE_SECRET:{Name}>`.

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
