package client

import (
	"context"

	"github.com/boxlite-ai/boxlite/sdks/go/internal/binding"
)

// Client is the main entry point for the BoxLite SDK.
type Client struct{}

// NewClient creates a new BoxLite client instance.
func NewClient() (*Client, error) {
	// Verify bridge is working
	if !binding.Ping() {
		return nil, ErrBridgeNotReady
	}
	return &Client{}, nil
}

// CreateBox creates a new box with the given options.
func (c *Client) CreateBox(ctx context.Context, opts BoxOptions, name string) (*Box, error) {
	bindingOpts := binding.BoxOptions{
		Image:      opts.Image,
		CPUs:       opts.CPUs,
		MemoryMB:   opts.MemoryMB,
		Env:        opts.Env,
		WorkingDir: opts.WorkingDir,
	}

	id, err := binding.CreateBox(bindingOpts, name)
	if err != nil {
		return nil, err
	}

	// Get the handle for the created box
	handle, _, err := binding.GetBox(id)
	if err != nil {
		return nil, err
	}

	return &Box{
		handle: handle,
		id:     id,
		name:   name,
	}, nil
}

// GetBox retrieves a box by ID or name.
// Returns nil if the box is not found (not an error).
func (c *Client) GetBox(ctx context.Context, idOrName string) (*Box, error) {
	handle, id, err := binding.GetBox(idOrName)
	if err != nil {
		return nil, err
	}
	if handle == nil {
		return nil, nil // Not found
	}

	return &Box{
		handle: handle,
		id:     id,
	}, nil
}

// ListBoxes returns information about all boxes.
func (c *Client) ListBoxes(ctx context.Context) ([]BoxInfo, error) {
	infos, err := binding.ListBoxes()
	if err != nil {
		return nil, err
	}

	result := make([]BoxInfo, len(infos))
	for i, info := range infos {
		result[i] = BoxInfo{
			ID:        info.ID,
			Name:      info.Name,
			Image:     info.Image,
			State:     info.State,
			CreatedAt: info.CreatedAt,
		}
	}
	return result, nil
}

// RemoveBox removes a box by ID or name.
// If force is true, the box will be stopped first if running.
func (c *Client) RemoveBox(ctx context.Context, idOrName string, force bool) error {
	return binding.RemoveBox(idOrName, force)
}
