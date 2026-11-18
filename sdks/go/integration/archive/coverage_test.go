//go:build boxlite_dev && boxlite_integration && boxlite_coverage

package archive_test

import (
	"fmt"
	"os"
	"testing"

	"github.com/boxlite-ai/boxlite/sdks/go/integration/archive/internal/nativeprofile"
)

func TestMain(m *testing.M) {
	result := m.Run()
	if !nativeprofile.Flush() {
		fmt.Fprintln(os.Stderr, "failed to flush native LLVM coverage")
		result = 1
	}
	os.Exit(result)
}
