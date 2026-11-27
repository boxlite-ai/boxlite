//go:build boxlite_dev

package boxlite

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestQuickstartTemplateCompiles(t *testing.T) {
	template, err := os.ReadFile("../../apps/dashboard/src/lib/quickstart/templates/go.go")
	if err != nil {
		t.Fatal(err)
	}
	code := strings.NewReplacer(
		"{{REST_API_URL}}", "https://api.test",
		"{{API_KEY_GO}}", `"test-key"`,
		"{{STEP_EXECUTION}}", "",
		"{{COMMAND_LITERAL}}", `"echo"`,
		"{{ARGUMENT_LITERALS}}", `"hello"`,
		"{{STEP_PREVIEW}}", "",
		"{{SERVER_GO}}", "`print('hello')`",
	).Replace(string(template))
	if strings.Contains(code, "{{") {
		t.Fatal("unresolved template token")
	}
	directory := t.TempDir()
	source := filepath.Join(directory, "main.go")
	if err := os.WriteFile(source, []byte(code), 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "go", "build", "-tags", "boxlite_dev", "-o", filepath.Join(directory, "quickstart"), source)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("Quickstart does not compile against the SDK: %v\n%s", err, output)
	}
}
