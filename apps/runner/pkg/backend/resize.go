package backend

import (
	"context"
	"github.com/boxlite-ai/runner/pkg/api/dto"
)

// ResourceResizer is optional: a backend without live growth must reject resize jobs.
type ResourceResizer interface {
	ResizeResources(context.Context, string, float64, uint32) (*dto.BoxResources, error)
}

func (a *BoxliteAdapter) ResizeResources(ctx context.Context, id string, cpus float64, memoryMiB uint32) (*dto.BoxResources, error) {
	return a.client.ResizeResources(ctx, id, cpus, memoryMiB)
}
