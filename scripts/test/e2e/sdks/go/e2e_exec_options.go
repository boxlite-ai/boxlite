// Go SDK e2e: exec with working dir + env vars.
// Called by cases/test_go_coverage.py.
package main

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/boxlite-ai/boxlite/sdks/go"
)

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func die(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "FATAL: "+format+"\n", args...)
	os.Exit(2)
}

func main() {
	url := env("BOXLITE_E2E_URL", "http://localhost:3000/api")
	apiKey := env("BOXLITE_E2E_API_KEY", "devkey")
	prefix := env("BOXLITE_E2E_PREFIX", "")
	image := env("BOXLITE_E2E_IMAGE", "alpine:3.23")

	rt, err := boxlite.NewRest(boxlite.BoxliteRestOptions{
		URL:        url,
		Credential: boxlite.NewApiKeyCredential(apiKey),
		PathPrefix: prefix,
	})
	if err != nil {
		die("NewRest: %v", err)
	}
	defer rt.Close()

	ctx := context.Background()
	box, err := rt.Create(ctx, image, boxlite.WithAutoRemove(true))
	if err != nil {
		die("Create: %v", err)
	}
	fmt.Printf("BOX_ID=%s\n", box.ID())
	defer func() {
		_ = rt.Remove(ctx, box.ID())
	}()

	// 1. exec pwd with working dir /tmp
	cmd1 := box.Command("pwd")
	cmd1.Dir = "/tmp"
	var out1 bytes.Buffer
	cmd1.Stdout = &out1
	if err := cmd1.Run(ctx); err != nil {
		die("pwd with Dir=/tmp: %v", err)
	}
	cwd := strings.TrimSpace(out1.String())
	fmt.Printf("CWD_OUTPUT=%s\n", cwd)

	// 2. exec printenv with custom env
	cmd2 := box.Command("printenv", "MY_KEY")
	cmd2.Env = map[string]string{"MY_KEY": "MY_VALUE"}
	var out2 bytes.Buffer
	cmd2.Stdout = &out2
	if err := cmd2.Run(ctx); err != nil {
		die("printenv MY_KEY: %v", err)
	}
	envVal := strings.TrimSpace(out2.String())
	fmt.Printf("ENV_VALUE=%s\n", envVal)

	fmt.Println("OK")
}
