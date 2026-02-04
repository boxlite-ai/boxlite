package client

import (
	"unsafe"

	"github.com/boxlite-ai/boxlite/sdks/go/internal/binding"
)

// Box represents a handle to a running or configured box.
type Box struct {
	handle unsafe.Pointer
	id     string
	name   string
}

// ID returns the unique identifier of the box.
func (b *Box) ID() string {
	return b.id
}

// Name returns the user-defined name of the box, if any.
func (b *Box) Name() string {
	return b.name
}

// Start starts the box (initializes the VM).
// This is idempotent - calling Start on a running box is a no-op.
func (b *Box) Start() error {
	return binding.BoxStart(b.handle)
}

// Stop stops the box.
func (b *Box) Stop() error {
	return binding.BoxStop(b.handle)
}

// Info returns current information about the box.
func (b *Box) Info() (*BoxInfo, error) {
	info, err := binding.GetBoxInfo(b.handle)
	if err != nil {
		return nil, err
	}
	return &BoxInfo{
		ID:        info.ID,
		Name:      info.Name,
		Image:     info.Image,
		State:     info.State,
		CreatedAt: info.CreatedAt,
	}, nil
}

// Close releases the box handle.
// The box itself continues to exist; this just releases the Go-side handle.
func (b *Box) Close() {
	if b.handle != nil {
		binding.BoxFree(b.handle)
		b.handle = nil
	}
}
