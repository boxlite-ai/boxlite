package main

import (
    "context"
    "fmt"
    "log"
    "os"
    "time"

    boxlite "github.com/boxlite-ai/boxlite/sdks/go"
)

func main() {
    ctx := context.Background()
    apiKey := {{API_KEY_GO}}
    if apiKey == "" {
        log.Fatal("Set BOXLITE_API_KEY before running this program")
    }

    apiURL := os.Getenv("BOXLITE_REST_URL")
    if apiURL == "" {
        apiURL = "{{REST_API_URL}}"
    }

    rt, err := boxlite.NewRest(boxlite.BoxliteRestOptions{
        URL:        apiURL,
        Credential: boxlite.NewApiKeyCredential(apiKey),
    })
    if err != nil {
        log.Fatal(err)
    }
    defer rt.Close()

    boxName := fmt.Sprintf("sdk-quickstart-go-%d", time.Now().Unix())
    box, err := rt.Create(
        ctx,
        "ghcr.io/boxlite-ai/boxlite-agent-base:20260605-p0-r3",
        boxlite.WithName(boxName),
    )
    if err != nil {
        log.Fatal(err)
    }
    if err := box.Start(ctx); err != nil {
        log.Fatal(err)
    }

    result, err := box.Exec(ctx, "echo", "Hello from BoxLite SDK")
    if err != nil {
        log.Fatal(err)
    }
    log.Println("Exit code:", result.ExitCode)
    log.Print(result.Stdout)

    if err := rt.ForceRemove(ctx, box.ID()); err != nil {
        log.Fatal(err)
    }
}
