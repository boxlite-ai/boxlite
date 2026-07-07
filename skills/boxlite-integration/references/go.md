# BoxLite Go SDK — Integration Patterns

## Install

```bash
go get github.com/boxlite-ai/boxlite/sdks/go
go run github.com/boxlite-ai/boxlite/sdks/go/cmd/setup
```

Requires Go 1.24+ with CGO enabled. The setup step downloads the prebuilt native library (one-time). Set `GITHUB_TOKEN` to avoid rate limits.

---

## Lifecycle Patterns

### Short-lived (script / single task)

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
    box, err := rt.Create(ctx, "python:slim")
    if err != nil {
        log.Fatal(err)
    }
    defer func() {
        rt.Remove(ctx, box.ID(), false)
    }()

    if err := box.Start(ctx); err != nil {
        log.Fatal(err)
    }

    exec, err := box.Exec(ctx, "python", []string{"-c", "print('hello')"})
    if err != nil {
        log.Fatal(err)
    }
    result, err := exec.Wait(ctx)
    if err != nil {
        log.Fatal(err)
    }
    fmt.Println(result.Stdout)
}
```

### Long-running (server / reuse box across calls)

```go
var (
    globalRuntime *boxlite.Runtime
    globalBox     *boxlite.Box
    boxMu         sync.Mutex
)

func getBox(ctx context.Context) (*boxlite.Box, error) {
    boxMu.Lock()
    defer boxMu.Unlock()
    if globalBox != nil {
        return globalBox, nil
    }
    rt, err := boxlite.NewRuntime()
    if err != nil {
        return nil, err
    }
    box, err := rt.Create(ctx, "python:slim")
    if err != nil {
        rt.Close()
        return nil, err
    }
    if err := box.Start(ctx); err != nil {
        rt.Remove(ctx, box.ID(), true)
        rt.Close()
        return nil, err
    }
    globalRuntime = rt
    globalBox = box
    return box, nil
}

func shutdown(ctx context.Context) {
    boxMu.Lock()
    defer boxMu.Unlock()
    if globalBox != nil {
        globalBox.Stop(ctx)
        globalRuntime.Remove(ctx, globalBox.ID(), true)
        globalBox = nil
    }
    if globalRuntime != nil {
        globalRuntime.Close()
        globalRuntime = nil
    }
}
```

---

## Timeout + Zombie Prevention

Cancelling a `context.Context` stops the Go-side wait but **does not kill the process inside the VM**. Kill explicitly:

```go
func safeExec(ctx context.Context, box *boxlite.Box, cmd string, args []string, timeout time.Duration) (*boxlite.ExecResult, error) {
    exec, err := box.Exec(ctx, cmd, args)
    if err != nil {
        return nil, err
    }

    execCtx, cancel := context.WithTimeout(ctx, timeout)
    defer cancel()

    result, err := exec.Wait(execCtx)
    if err != nil {
        exec.Kill(ctx) // kill guest process — not optional
        return nil, fmt.Errorf("exec timed out or failed: %w", err)
    }
    return result, nil
}
```

---

## Box Options

```go
box, err := rt.Create(ctx, "python:slim",
    boxlite.WithName("my-agent-box"),
    boxlite.WithCPUs(2),
    boxlite.WithMemory(1024),  // MiB
    boxlite.WithNetwork(boxlite.NetworkSpec{
        Mode:     boxlite.NetworkModeEnabled,
        AllowNet: []string{"api.openai.com"},
    }),
    boxlite.WithSecret(boxlite.Secret{
        Name:  "openai",
        Value: os.Getenv("OPENAI_API_KEY"),
        Hosts: []string{"api.openai.com"},
    }),
)
```

---

## LLM Tool Call Pattern

```go
type CodeRunner struct {
    runtime *boxlite.Runtime
    box     *boxlite.Box
    mu      sync.Mutex
}

func NewCodeRunner(ctx context.Context) (*CodeRunner, error) {
    rt, err := boxlite.NewRuntime()
    if err != nil {
        return nil, err
    }
    box, err := rt.Create(ctx, "python:slim")
    if err != nil {
        rt.Close()
        return nil, err
    }
    if err := box.Start(ctx); err != nil {
        rt.Remove(ctx, box.ID(), true)
        rt.Close()
        return nil, err
    }
    return &CodeRunner{runtime: rt, box: box}, nil
}

func (r *CodeRunner) Run(ctx context.Context, code string) (string, error) {
    r.mu.Lock()
    defer r.mu.Unlock()
    return safeExec(ctx, r.box, "python", []string{"-c", code}, 30*time.Second)
}

func (r *CodeRunner) Close(ctx context.Context) {
    r.box.Stop(ctx)
    r.runtime.Remove(ctx, r.box.ID(), true)
    r.runtime.Close()
}
```

---

## Environment Setup

```bash
# Local (default)
go get github.com/boxlite-ai/boxlite/sdks/go
go run github.com/boxlite-ai/boxlite/sdks/go/cmd/setup

# Cloud / REST
export BOXLITE_API_KEY="your-api-key"
export BOXLITE_REST_URL="https://api.boxlite.ai/api"
```

For development builds from source: `make dev:go` from the repo root.
