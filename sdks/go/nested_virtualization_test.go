package boxlite

import (
	"context"
	"strings"
	"testing"
)

func TestNestedVirtualizationCreateAuthorization(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		t.Run(map[bool]string{false: "ordinary", true: "nested"}[enabled], func(t *testing.T) {
			advanced, err := NewAdvancedBoxOptions()
			if err != nil {
				t.Fatal(err)
			}
			defer advanced.Close()
			if err := advanced.SetNestedVirtualization(enabled); err != nil {
				t.Fatal(err)
			}
			runtime, err := NewRuntime(WithHomeDir(t.TempDir()))
			if err != nil {
				t.Fatal(err)
			}
			defer runtime.Close()
			box, err := runtime.Create(context.Background(), "alpine:latest", WithName("authorization"), WithDetach(true), WithAutoRemove(false), WithAdvancedOptions(advanced))
			if enabled {
				if err == nil {
					box.Close()
					t.Fatal("nested create bypassed runtime authorization")
				}
				if !strings.Contains(err.Error(), "nested-virtualization") {
					t.Fatalf("unexpected authorization error: %v", err)
				}
			} else {
				if err != nil {
					t.Fatal(err)
				}
				box.Close()
			}
		})
	}
}

func TestNestedVirtualizationCreatePersistsAcrossRuntimeReopen(t *testing.T) {
	home := t.TempDir()
	ctx := context.Background()
	advanced, err := NewAdvancedBoxOptions()
	if err != nil {
		t.Fatal(err)
	}
	defer advanced.Close()
	if err := advanced.SetNestedVirtualization(true); err != nil {
		t.Fatal(err)
	}
	var id string
	for attempt := 0; attempt < 3; attempt++ {
		runtime, err := NewRuntime(WithHomeDir(home), WithExperimentalFeatures("nested-virtualization"))
		if err != nil {
			t.Fatal(err)
		}
		options := []BoxOption{WithName("saved-nesting"), WithAutoRemove(false), WithDetach(true)}
		// An ordinary replay must not overwrite the original nested configuration.
		if attempt != 1 {
			options = append(options, WithAdvancedOptions(advanced))
		}
		box, created, err := runtime.GetOrCreate(ctx, "alpine:latest", options...)
		if err != nil {
			runtime.Close()
			t.Fatalf("attempt %d: %v", attempt, err)
		}
		if created != (attempt == 0) {
			t.Fatalf("attempt %d: created=%t", attempt, created)
		}
		if attempt == 0 {
			id = box.ID()
		} else if box.ID() != id {
			t.Fatalf("identity changed: %s -> %s", id, box.ID())
		}
		box.Close()
		if err := runtime.Close(); err != nil {
			t.Fatal(err)
		}
	}
	advanced.Close()
	if err := advanced.SetNestedVirtualization(false); err == nil {
		t.Fatal("setter accepted closed handle")
	}
}
