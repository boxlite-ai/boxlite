package executor

import (
	"context"
	"testing"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	"github.com/boxlite-ai/runner/pkg/api/dto"
	"github.com/boxlite-ai/runner/pkg/backend"
)

type memoryBackend struct {
	backend.BoxBackend
	quota float64
}

func (b *memoryBackend) Create(_ context.Context, request dto.CreateBoxDTO) (string, string, error) {
	b.quota = float64(request.MemoryQuota)
	return request.Id, "test", nil
}

func TestMiBMemoryCreateJob(t *testing.T) {
	raw := `{"id":"memory","memoryQuota":0.29296875}`
	b := &memoryBackend{}
	executor := &Executor{backend: b}
	if _, err := executor.createBox(context.Background(), &apiclient.Job{Payload: &raw}); err != nil {
		t.Fatalf("300 MiB job must decode and reach the backend: %v", err)
	}
	if b.quota != 0.29296875 {
		t.Fatalf("memory allocation changed: got %v GiB", b.quota)
	}
}
