package boxlite

import (
	"log/slog"
	"math"
	"strings"
	"testing"

	"github.com/boxlite-ai/runner/pkg/api/dto"
	"github.com/containerd/errdefs"
)

func TestMemoryRejectedBeforeCreateOrDestructiveRecovery(t *testing.T) {
	enabled := true
	// Accessing the deliberately nil runtime would panic if validation came after Destroy.
	client := &Client{logger: slog.Default()}
	for _, gib := range []float64{0, -1, 255.0 / 1024, 255.5 / 1024, math.NaN(), math.Inf(1), float64(math.MaxInt32+1) / 1024} {
		_, _, err := client.Create(t.Context(), dto.CreateBoxDTO{MemoryQuota: gib, OutboundEnabled: &enabled})
		if !errdefs.IsInvalidArgument(err) || !strings.Contains(err.Error(), "memoryQuota") {
			t.Fatalf("Create(%v): %v", gib, err)
		}
		err = client.RecoverBox(t.Context(), "existing", dto.RecoverBoxDTO{MemoryQuota: gib, OutboundEnabled: &enabled})
		if !errdefs.IsInvalidArgument(err) || !strings.Contains(err.Error(), "memoryQuota") {
			t.Fatalf("Recover(%v): %v", gib, err)
		}
	}
}
