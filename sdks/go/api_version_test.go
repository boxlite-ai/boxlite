//go:build unix

package boxlite

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// Native SDK tests build this checkout's library and advertise its generated contract.
func apiVersionConfig(t *testing.T) string {
	t.Helper()
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate the generated API identity")
	}
	data, err := os.ReadFile(filepath.Join(filepath.Dir(source), "../../src/boxlite/src/rest/api_version.json"))
	if err != nil {
		t.Fatal(err)
	}
	var version string
	if err := json.Unmarshal(data, &version); err != nil {
		t.Fatal(err)
	}
	config, err := json.Marshal(map[string]string{"api_version": version})
	if err != nil {
		t.Fatal(err)
	}
	return string(config)
}
