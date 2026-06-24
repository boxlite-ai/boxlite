// Go SDK e2e: error typing — bogus image + nonexistent box.
// Called by cases/test_go_coverage.py.
package main

import (
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

	// 1. create with bogus image
	_, err = rt.Create(ctx, "this-image-does-not-exist:0.0.0")
	if err == nil {
		die("bogus image create should have failed")
	}
	errMsg := strings.ToLower(err.Error())
	if strings.Contains(errMsg, "500") && strings.Contains(errMsg, "internal") {
		die("bogus image leaked 500: %v", err)
	}
	fmt.Println("IMAGE_ERROR=typed")

	// 2. get nonexistent box
	box, err := rt.Get(ctx, "00000000-0000-0000-0000-000000000000")
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "500") {
			die("get nonexistent leaked 500: %v", err)
		}
		fmt.Println("NOT_FOUND=typed")
	} else if box == nil {
		fmt.Println("NOT_FOUND=null")
	} else {
		die("get nonexistent should have returned nil or error")
	}

	fmt.Println("OK")
}
