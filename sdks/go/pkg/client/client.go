package client

import (
	"context"

	"github.com/boxlite-ai/boxlite/sdks/go/internal/binding"
)

// boxProvider abstracts the underlying Box handle.
type boxProvider interface {
	Start() error
	Stop() error
	Info() (binding.BoxInfo, error)
	Exec(command string, opts binding.ExecOptions) (binding.ExecResult, error)
	Free()
}

// runtimeProvider abstracts the underlying BoxLite runtime.
type runtimeProvider interface {
	CreateBox(name string, opts binding.BoxOptions) (string, error)
	GetBox(idOrName string) (boxProvider, string, error)
	ListBoxes() ([]binding.BoxInfo, error)
	RemoveBox(idOrName string, force bool) error
	Free()
}

// defaultRuntimeProvider wraps the CGo *binding.Runtime to implement runtimeProvider.
type defaultRuntimeProvider struct {
	rt *binding.Runtime
}

func (p *defaultRuntimeProvider) CreateBox(name string, opts binding.BoxOptions) (string, error) {
	return p.rt.CreateBox(name, opts)
}

func (p *defaultRuntimeProvider) GetBox(idOrName string) (boxProvider, string, error) {
	box, id, err := p.rt.GetBox(idOrName)
	if box == nil {
		return nil, id, err
	}
	return box, id, err
}

func (p *defaultRuntimeProvider) ListBoxes() ([]binding.BoxInfo, error) {
	return p.rt.ListBoxes()
}

func (p *defaultRuntimeProvider) RemoveBox(idOrName string, force bool) error {
	return p.rt.RemoveBox(idOrName, force)
}

func (p *defaultRuntimeProvider) Free() {
	p.rt.Free()
}

// Runtime wraps a runtimeProvider and exposes a high-level API.
type Runtime struct {
	runtime runtimeProvider
}

// NewRuntime creates a new BoxLite Runtime instance.
func NewRuntime(opts *RuntimeOptions) (*Runtime, error) {
	bindingOpts := &binding.RuntimeOptions{}
	if opts != nil {
		bindingOpts.HomeDir = opts.HomeDir
		bindingOpts.ImageRegistries = opts.ImageRegistries
	}
	runtime, err := binding.NewRuntime(bindingOpts)
	if err != nil {
		return nil, err
	}
	return &Runtime{runtime: &defaultRuntimeProvider{rt: runtime}}, nil
}

// newRuntimeWith creates a Runtime backed by the given runtimeProvider implementation.
// Intended for use in tests to inject a custom or mock implementation.
func newRuntimeWith(p runtimeProvider) *Runtime {
	return &Runtime{runtime: p}
}

// Close releases the runtime and all associated resources.
func (r *Runtime) Close() {
	if r.runtime != nil {
		r.runtime.Free()
		r.runtime = nil
	}
}

// CreateBox creates a new box with the given options and optional name.
func (r *Runtime) CreateBox(ctx context.Context, name string, opts BoxOptions) (*Box, error) {
	id, err := r.runtime.CreateBox(name, binding.BoxOptions{
		Image:      opts.Image,
		CPUs:       opts.CPUs,
		MemoryMB:   opts.MemoryMB,
		Env:        opts.Env,
		WorkingDir: opts.WorkingDir,
	})
	if err != nil {
		return nil, err
	}
	handle, _, err := r.runtime.GetBox(id)
	if err != nil {
		return nil, err
	}
	return &Box{handle: handle, id: id, name: name, runtime: r}, nil
}

// GetBox retrieves a box by ID or name. Returns nil (not an error) if the box does not exist.
func (r *Runtime) GetBox(ctx context.Context, idOrName string) (*Box, error) {
	handle, id, err := r.runtime.GetBox(idOrName)
	if err != nil {
		return nil, err
	}
	if handle == nil {
		return nil, nil
	}
	return &Box{handle: handle, id: id, runtime: r}, nil
}

// ListBoxes returns information about all boxes managed by this runtime.
func (r *Runtime) ListBoxes(ctx context.Context) ([]BoxInfo, error) {
	infos, err := r.runtime.ListBoxes()
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

// RemoveBox removes the box identified by ID or name.
func (r *Runtime) RemoveBox(ctx context.Context, idOrName string, force bool) error {
	return r.runtime.RemoveBox(idOrName, force)
}
