package boxlite

import (
	"context"
	"log/slog"
	"testing"

	"github.com/boxlite-ai/runner/pkg/api/dto"
	"github.com/containerd/errdefs"
)

func cpuQuota(cores float64) *float64 { return &cores }

func TestFractionalCPUInvalidBeforeRuntime(t *testing.T) {
	// An uninitialized runtime would panic if either operation proceeded to
	// mounts, destruction or creation before validating this request.
	client := &Client{logger: slog.Default()}
	for _, n := range []float64{0, -1, dto.MinCPUs - 0.001, dto.MinCPUs + 0.0001, 16.001} {
		_, _, err := client.Create(context.Background(), dto.CreateBoxDTO{CpuQuota: cpuQuota(n)})
		if !errdefs.IsInvalidArgument(err) {
			t.Fatalf("Create(%v): %v", n, err)
		}
		err = client.RecoverBox(context.Background(), "existing", dto.RecoverBoxDTO{CpuQuota: cpuQuota(n)})
		if !errdefs.IsInvalidArgument(err) {
			t.Fatalf("Recover(%v): %v", n, err)
		}
	}
}
