package executor

import (
	"context"
	"testing"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	"github.com/boxlite-ai/runner/pkg/api/dto"
	"github.com/boxlite-ai/runner/pkg/backend"
)

type cpuBackend struct {
	backend.BoxBackend
	allocation float64
}

func (b *cpuBackend) Create(_ context.Context, request dto.CreateBoxDTO) (string, string, error) {
	cores, err := dto.CPUAllocation(request.CpuQuota)
	b.allocation = cores
	return request.Id, "test", err
}
func TestFractionalCPUJob(t *testing.T) {
	for _, tc := range []struct {
		raw  string
		want float64
	}{
		{`{"id":"cpu","cpuQuota":0.125}`, 0.125},
		{`{"id":"cpu","cpuQuota":1.001}`, 1.001},
	} {
		raw := tc.raw
		b := &cpuBackend{}
		executor := &Executor{backend: b}
		if _, err := executor.createBox(context.Background(), &apiclient.Job{Payload: &raw}); err != nil {
			t.Fatal(err)
		}
		if b.allocation != tc.want {
			t.Fatalf("lost allocation: %v", b.allocation)
		}
	}
}
