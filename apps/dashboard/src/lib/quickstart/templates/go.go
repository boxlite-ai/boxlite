package main

import (
    "context"
    "errors"
    "fmt"
    "net"
    "os"
    "time"
    boxlite "github.com/boxlite-ai/boxlite/sdks/go"
)

func run() error {
    ctx := context.Background()
    apiURL := os.Getenv("BOXLITE_REST_URL")
    if apiURL == "" { apiURL = "{{REST_API_URL}}" }
    rt, err := boxlite.NewRest(boxlite.BoxliteRestOptions{
        URL: apiURL, Credential: boxlite.NewApiKeyCredential({{API_KEY_GO}}),
    })
    if err != nil { return err }
    defer rt.Close()
    box, err := rt.Create(ctx, "ghcr.io/boxlite-ai/boxlite-agent-base:v0.1.0",
        boxlite.WithName(fmt.Sprintf("sdk-quickstart-go-%d", time.Now().UnixNano())),
        boxlite.WithNetwork(boxlite.NetworkSpec{
            Inbound: boxlite.InboundNetworkSpec{Mode: boxlite.NetworkModeEnabled},
        }),
    )
    if err != nil { return err }
    fmt.Println("Created Box:", box.ID())
    if err = box.Start(ctx); err != nil { return err }
{{STEP_EXECUTION}}
    result, err := box.Exec(ctx, {{COMMAND_LITERAL}}, {{ARGUMENT_LITERALS}})
    if err != nil { return err }
    fmt.Print(result.Stdout)
    if result.ExitCode != 0 { return fmt.Errorf("command exited with %d", result.ExitCode) }
{{STEP_PREVIEW}}
    serverCode := {{SERVER_GO}}
    // Detach the server so closing local SDK handles leaves it running.
    started, err := box.Exec(ctx, "sh", "-c",
        `nohup python3 -u -c "$1" >/tmp/preview.log 2>&1 </dev/null &`, "sh", serverCode)
    if err != nil { return err }
    if started.ExitCode != 0 { return fmt.Errorf("server launch exited with %d", started.ExitCode) }
    network, err := box.Network()
    if err != nil { return err }
    preview, err := network.Tunnel(ctx, &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 3000}, boxlite.DefaultTunnelOptions())
    if err != nil { return err }
    defer preview.Close()
    url, err := preview.URI()
    if err != nil { return err }
    if url == "" { return errors.New("Cloud did not return a preview URL") }
    fmt.Println("Preview URL:", url)
    return nil
}

func main() {
    if err := run(); err != nil { fmt.Fprintln(os.Stderr, err); os.Exit(1) }
}
