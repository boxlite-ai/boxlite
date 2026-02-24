package client

import (
	"context"
	"errors"
	"testing"
)

// newTestRuntime is a test helper that creates a Runtime backed by a mock.
func newTestRuntime(m *mockRuntimeProvider) *Runtime {
	return newRuntimeWith(m)
}

// ============================================================================
// Runtime lifecycle
// ============================================================================

func TestRuntime_Close_Idempotent(t *testing.T) {
	m := newMockRuntimeProvider()
	r := newTestRuntime(m)

	r.Close()
	r.Close() // second Close must not panic

	if !m.freed {
		t.Error("expected Free() to be called on the mock runtime")
	}
}

// ============================================================================
// CreateBox
// ============================================================================

func TestCreateBox(t *testing.T) {
	tests := []struct {
		name       string
		setup      func(*mockRuntimeProvider)
		boxName    string
		wantErr    string
		wantName   string
		wantNonNil bool
	}{
		{
			name:       "success",
			boxName:    "my-box",
			wantNonNil: true,
			wantName:   "my-box",
		},
		{
			name:    "propagates_create_error",
			setup:   func(m *mockRuntimeProvider) { m.SetCreateError(errors.New("image pull failed")) },
			wantErr: "image pull failed",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			m := newMockRuntimeProvider()
			if tc.setup != nil {
				tc.setup(m)
			}
			r := newTestRuntime(m)
			box, err := r.CreateBox(context.Background(), tc.boxName, NewBoxOptions("alpine:latest"))

			if tc.wantErr != "" {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				if err.Error() != tc.wantErr {
					t.Errorf("error: got %q, want %q", err.Error(), tc.wantErr)
				}
				return
			}

			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if tc.wantNonNil && box == nil {
				t.Fatal("expected non-nil box")
			}
			if box.ID() == "" {
				t.Error("box ID must not be empty")
			}
			if tc.wantName != "" && box.Name() != tc.wantName {
				t.Errorf("Name: got %q, want %q", box.Name(), tc.wantName)
			}
		})
	}
}

// ============================================================================
// GetBox
// ============================================================================

func TestGetBox(t *testing.T) {
	tests := []struct {
		name    string
		setup   func(*mockRuntimeProvider)
		query   string
		wantNil bool
		wantErr bool
	}{
		{
			name:  "found",
			setup: func(m *mockRuntimeProvider) { m.AddBox("box-001", "alpine:latest") },
			query: "box-001",
		},
		{
			name:    "not_found_returns_nil_no_error",
			query:   "nonexistent",
			wantNil: true,
		},
		{
			name:    "propagates_get_error",
			setup:   func(m *mockRuntimeProvider) { m.SetGetError(errors.New("storage error")) },
			query:   "any-box",
			wantErr: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			m := newMockRuntimeProvider()
			if tc.setup != nil {
				tc.setup(m)
			}
			r := newTestRuntime(m)
			box, err := r.GetBox(context.Background(), tc.query)

			if tc.wantErr {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				return
			}

			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if tc.wantNil && box != nil {
				t.Error("expected nil box")
			}
			if !tc.wantNil && box == nil {
				t.Error("expected non-nil box")
			}
		})
	}
}

// ============================================================================
// ListBoxes
// ============================================================================

func TestListBoxes(t *testing.T) {
	tests := []struct {
		name      string
		setup     func(*mockRuntimeProvider)
		wantCount int
		wantErr   bool
	}{
		{
			name:      "empty",
			wantCount: 0,
		},
		{
			name: "multiple",
			setup: func(m *mockRuntimeProvider) {
				m.AddBox("box-001", "alpine:latest")
				m.AddBox("box-002", "ubuntu:22.04")
				m.AddBox("box-003", "debian:bookworm")
			},
			wantCount: 3,
		},
		{
			name:    "propagates_list_error",
			setup:   func(m *mockRuntimeProvider) { m.SetListError(errors.New("db connection lost")) },
			wantErr: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			m := newMockRuntimeProvider()
			if tc.setup != nil {
				tc.setup(m)
			}
			r := newTestRuntime(m)
			boxes, err := r.ListBoxes(context.Background())

			if tc.wantErr {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				return
			}

			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if len(boxes) != tc.wantCount {
				t.Errorf("box count: got %d, want %d", len(boxes), tc.wantCount)
			}
		})
	}
}

// ============================================================================
// RemoveBox
// ============================================================================

func TestRemoveBox(t *testing.T) {
	tests := []struct {
		name    string
		setup   func(*mockRuntimeProvider)
		target  string
		wantErr bool
	}{
		{
			name:   "success",
			setup:  func(m *mockRuntimeProvider) { m.AddBox("box-001", "alpine:latest") },
			target: "box-001",
		},
		{
			name:    "not_found_returns_error",
			target:  "nonexistent",
			wantErr: true,
		},
		{
			name:    "propagates_remove_error",
			setup:   func(m *mockRuntimeProvider) { m.SetRemoveError(errors.New("permission denied")) },
			target:  "any-box",
			wantErr: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			m := newMockRuntimeProvider()
			if tc.setup != nil {
				tc.setup(m)
			}
			r := newTestRuntime(m)
			err := r.RemoveBox(context.Background(), tc.target, false)

			if tc.wantErr {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				return
			}

			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			boxes, _ := r.ListBoxes(context.Background())
			if len(boxes) != 0 {
				t.Errorf("expected empty list after removal, got %d boxes", len(boxes))
			}
		})
	}
}

// ============================================================================
// Box operations
// ============================================================================

func TestBox_Start(t *testing.T) {
	tests := []struct {
		name      string
		setup     func(*mockRuntimeProvider)
		wantErr   bool
		wantState string
	}{
		{
			name:      "success_transitions_to_running",
			wantState: "running",
		},
		{
			name:    "propagates_start_error",
			setup:   func(m *mockRuntimeProvider) { m.boxes["box-001"].startErr = errors.New("vm boot failed") },
			wantErr: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			m := newMockRuntimeProvider()
			m.AddBox("box-001", "alpine:latest")
			if tc.setup != nil {
				tc.setup(m)
			}
			r := newTestRuntime(m)

			box, err := r.GetBox(context.Background(), "box-001")
			if err != nil || box == nil {
				t.Fatalf("GetBox: unexpected error or nil box: %v", err)
			}

			err = box.Start()
			if tc.wantErr {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if tc.wantState != "" {
				info, _ := box.Info()
				if info.State != tc.wantState {
					t.Errorf("state: got %q, want %q", info.State, tc.wantState)
				}
			}
		})
	}
}

func TestBox_Stop(t *testing.T) {
	t.Run("propagates_stop_error", func(t *testing.T) {
		m := newMockRuntimeProvider()
		mockB := m.AddBox("box-001", "alpine:latest")
		mockB.stopErr = errors.New("vm stop timeout")
		r := newTestRuntime(m)

		box, _ := r.GetBox(context.Background(), "box-001")
		if err := box.Stop(); err == nil {
			t.Fatal("expected error, got nil")
		}
	})
}

func TestBox_Close_Idempotent(t *testing.T) {
	m := newMockRuntimeProvider()
	r := newTestRuntime(m)

	box, _ := r.CreateBox(context.Background(), "", NewBoxOptions("alpine:latest"))
	box.Close()
	box.Close() // second Close must not panic
}
