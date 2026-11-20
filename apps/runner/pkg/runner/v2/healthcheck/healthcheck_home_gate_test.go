package healthcheck

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"testing"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
)

// countingHandler counts every record that reaches it, so a test can assert a
// log fires once and not again.
type countingHandler struct {
	records int
}

func (h *countingHandler) Enabled(context.Context, slog.Level) bool { return true }
func (h *countingHandler) Handle(_ context.Context, _ slog.Record) error {
	h.records++
	return nil
}
func (h *countingHandler) WithAttrs([]slog.Attr) slog.Handler { return h }
func (h *countingHandler) WithGroup(string) slog.Handler      { return h }

// TestDataDiskRefHomeGate pins the reporting contract this change adds: a
// complete environment assembles the disk identity, but only a passing gate
// check puts it on the wire. Every case drives newHealthcheck, the production
// decision point, and asserts on the exact object the healthcheck loop sends.
func TestDataDiskRefHomeGate(t *testing.T) {
	identity := apiclient.NewRunnerDataDiskRef("gcp", "proj", "us-central1-a", "disk-1")
	identity.SetDiskType("hyperdisk_balanced")

	newService := func(hook func(string, string) error) *Service {
		return &Service{
			log:                  slog.New(&countingHandler{}),
			dataDiskRef:          identity,
			boxliteHomeDir:       "/var/lib/boxlite",
			dataDiskDevicePath:   "/dev/disk/by-id/google-boxlite-data",
			verifyHomeOnDataDisk: hook,
		}
	}

	// advertised marshals the healthcheck the production loop would send and
	// reports whether the disk identity rides on it.
	advertised := func(s *Service) bool {
		t.Helper()
		payload, err := json.Marshal(s.newHealthcheck(false))
		if err != nil {
			t.Fatalf("marshal healthcheck: %v", err)
		}
		var m map[string]any
		if err := json.Unmarshal(payload, &m); err != nil {
			t.Fatalf("unmarshal healthcheck: %v", err)
		}
		_, ok := m["dataDiskRef"]
		return ok
	}

	t.Run("device carrying the home advertises the identity", func(t *testing.T) {
		s := newService(func(string, string) error { return nil })
		if !advertised(s) {
			t.Fatalf("identity not advertised despite a passing gate check")
		}
	})

	t.Run("complete environment without a carrying device omits the ref (legacy host)", func(t *testing.T) {
		s := newService(func(string, string) error {
			return fmt.Errorf("data disk device not found: /dev/disk/by-id/google-boxlite-data")
		})
		if advertised(s) {
			t.Fatalf("identity advertised despite a failing gate check")
		}
	})

	t.Run("empty device path never advertises", func(t *testing.T) {
		s := newService(func(string, string) error { return nil })
		s.dataDiskDevicePath = ""
		if advertised(s) {
			t.Fatalf("identity advertised without a device path")
		}
	})

	t.Run("absent identity never advertises", func(t *testing.T) {
		s := &Service{
			log:                  slog.New(&countingHandler{}),
			dataDiskRef:          nil,
			boxliteHomeDir:       "/var/lib/boxlite",
			dataDiskDevicePath:   "/dev/disk/by-id/google-boxlite-data",
			verifyHomeOnDataDisk: func(string, string) error { return nil },
		}
		if advertised(s) {
			t.Fatalf("identity advertised without the environment triple")
		}
	})

	t.Run("failure logs once per process, not per tick", func(t *testing.T) {
		handler := &countingHandler{}
		s := &Service{
			log:                  slog.New(handler),
			dataDiskRef:          identity,
			boxliteHomeDir:       "/var/lib/boxlite",
			dataDiskDevicePath:   "/dev/disk/by-id/google-boxlite-data",
			verifyHomeOnDataDisk: func(string, string) error { return fmt.Errorf("data disk device not found") },
		}
		for range 2 {
			if advertised(s) {
				t.Fatalf("identity advertised despite a failing gate check")
			}
		}
		if handler.records != 1 {
			t.Fatalf("gate-skip logged %d times, want once", handler.records)
		}
	})
}
