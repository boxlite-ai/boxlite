# BoxLite Go SDK

Go SDK for BoxLite — an embeddable virtual machine runtime for secure, isolated code execution.

## Install

```bash
go get github.com/boxlite-ai/boxlite/sdks/go
go run github.com/boxlite-ai/boxlite/sdks/go/cmd/setup
```

Requires Go 1.24+ with CGO enabled. The setup step downloads the prebuilt native library from GitHub Releases (one-time). Set `GITHUB_TOKEN` to avoid API rate limits.

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
	rt, err := boxlite.NewRuntime()
	if err != nil {
		log.Fatal(err)
	}
	defer rt.Close()

	ctx := context.Background()
	box, err := rt.CreateBox(ctx,
		boxlite.NewBoxOptions("alpine:latest").
			WithCPUs(1).
			WithMemoryMB(512),
		"my-box",
	)
	if err != nil {
		log.Fatal(err)
	}

	if err := box.Start(); err != nil {
		log.Fatal(err)
	}

	fmt.Println("Box started successfully!")
}
```

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
