//go:build linux

package guardinventory

import (
	"context"
	"strconv"
	"testing"
	"time"
)

func TestTopologyCommandOutputLimit(t *testing.T) {
	const limit = 1 << 20
	for _, test := range []struct {
		name string
		size int
	}{
		{"at limit", limit},
		{"one byte over", limit + 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			output, err := topologyCommand(ctx, "head", []string{"-c", strconv.Itoa(test.size), "/dev/zero"})
			if test.size > limit {
				if err == nil || output != nil || ctx.Err() != nil {
					t.Fatalf("oversized topology: got %d bytes, error %v, context %v", len(output), err, ctx.Err())
				}
				return
			}
			if err != nil || len(output) != test.size {
				t.Fatalf("topology at limit: got %d bytes, error %v", len(output), err)
			}
		})
	}
}
