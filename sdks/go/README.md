# BoxLite Go SDK

Go SDK for BoxLite - an embeddable virtual machine runtime for secure, isolated code execution environments.

## Requirements

- Go 1.21 or later
- Rust toolchain (for building the native library)

## Building

### Build the Rust library first

```bash
cd ../..
make runtime-debug
```

### Build the Go SDK

```bash
# From the project root
make go-build

# Or from this directory
go build ./...
```

## Testing

### Run Go SDK tests

```bash
# From the project root
make test:go

# Or from this directory
go test ./... -v
```

**Note:** Tests that require the Rust library will be skipped if the library is not built.

### Run all tests

```bash
make test
```

This runs tests for all SDKs (Rust, Python, Node.js, Go, and C).

## Usage Example

```go
package main

import (
    "context"
    "fmt"
    "log"

    "github.com/boxlite-ai/boxlite/sdks/go/pkg/client"
)

func main() {
    // Create runtime
    runtime, err := client.NewRuntime(nil)
    if err != nil {
        log.Fatal(err)
    }
    defer runtime.Close()

    // Create a box
    ctx := context.Background()
    box, err := runtime.CreateBox(ctx,
        client.NewBoxOptions("alpine:latest").
            WithCPUs(1).
            WithMemoryMB(512).
            WithEnvVar("KEY", "value"),
        "my-box",
    )
    if err != nil {
        log.Fatal(err)
    }

    // Start the box
    if err := box.Start(); err != nil {
        log.Fatal(err)
    }

    fmt.Println("Box started successfully!")
}
```

## API Documentation

See the Go package documentation for detailed API reference:

- `client.Runtime` - Main entry point for the SDK
- `client.Box` - Handle to a running or configured box
- `client.BoxOptions` - Configuration options for creating boxes

## License

Apache-2.0
