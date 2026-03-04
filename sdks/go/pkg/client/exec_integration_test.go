//go:build integration

package client_test

import (
	"testing"

	"github.com/boxlite-ai/boxlite/sdks/go/pkg/client"
)

func TestBoxExec(t *testing.T) {
	rt, err := client.NewRuntime(nil)
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Close()

	box, err := rt.CreateBox(t.Context(), "test-exec", client.BoxOptions{Image: "alpine:latest"})
	if err != nil {
		t.Fatal(err)
	}
	defer box.Close()

	if err := box.Start(); err != nil {
		t.Fatal(err)
	}
	defer box.Stop()

	result, err := box.Exec("echo", &client.ExecOptions{
		Args: []string{"hello", "from", "boxlite"},
	})
	if err != nil {
		t.Fatal(err)
	}

	if result.ExitCode != 0 {
		t.Fatalf("expected exit 0, got %d", result.ExitCode)
	}
	if len(result.Stdout) == 0 {
		t.Fatal("expected stdout output")
	}
	t.Logf("stdout: %v", result.Stdout)
}
