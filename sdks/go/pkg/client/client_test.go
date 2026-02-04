package client

import (
	"context"
	"testing"

	"github.com/boxlite-ai/boxlite/sdks/go/internal/binding"
)

func TestNewClient(t *testing.T) {
	// Note: This test requires the Rust library to be built and linked.
	// In CI, this should be run after `make build-rust`.
	c, err := NewClient()
	if err != nil {
		t.Fatalf("Failed to create client: %v", err)
	}

	if c == nil {
		t.Fatal("Expected non-nil client")
	}
}

func TestBridgePing(t *testing.T) {
	if !binding.Ping() {
		t.Fatal("Bridge ping failed - Go-Rust bridge is not working correctly")
	}
}

func TestClientListBoxes(t *testing.T) {
	c, err := NewClient()
	if err != nil {
		t.Fatalf("Failed to create client: %v", err)
	}

	// ListBoxes should work even if empty
	boxes, err := c.ListBoxes(context.Background())
	if err != nil {
		t.Fatalf("Failed to list boxes: %v", err)
	}

	// Just verify it doesn't crash and returns a slice
	t.Logf("Found %d boxes", len(boxes))
}
