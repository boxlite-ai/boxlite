package boxlite

import (
	"context"

	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/api/dto"
)

func (c *Client) ResizeResources(ctx context.Context, boxID string, cpus uint8, memoryMiB uint32) (*dto.BoxResources, error) {
	box, err := c.GetBox(ctx, boxID)
	if err != nil {
		return nil, err
	}
	r, err := box.Resize(ctx, boxlite.ResizeOptions{CPUs: cpus, MemoryMiB: memoryMiB})
	if err != nil {
		return nil, err
	}
	return &dto.BoxResources{CPUs: r.CPUs, MemoryMiB: r.MemoryMiB, MaxCPUs: r.MaxCPUs, MaxMemoryMiB: r.MaxMemoryMiB}, nil
}
