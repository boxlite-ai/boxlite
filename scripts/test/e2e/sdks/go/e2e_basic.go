// Minimal Go SDK e2e smoke driver, called by cases/test_go_entry.py.
//
// Reads connection settings from env (BOXLITE_E2E_URL / API_KEY / PREFIX /
// IMAGE), creates a box via the REST runtime, exec's `echo HELLO-FROM-GO`,
// prints the box id + captured stdout, and removes the box.
//
// Exit code 0 on success. The pytest wrapper parses stdout for the box
// id and stdout marker, and cross-checks the runner journal.
package main

import (
	"context"
	"fmt"
	"os"

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

	result, err := box.Exec(ctx, "echo", "HELLO-FROM-GO")
	if err != nil {
		_ = rt.Remove(ctx, box.ID())
		die("Exec: %v", err)
	}
	fmt.Printf("EXIT_CODE=%d\n", result.ExitCode)
	fmt.Printf("STDOUT=%s", result.Stdout)

	if err := rt.Remove(ctx, box.ID()); err != nil {
		fmt.Fprintf(os.Stderr, "Remove (best-effort): %v\n", err)
	}

	if result.ExitCode != 0 {
		die("exec exit_code=%d", result.ExitCode)
	}
}
