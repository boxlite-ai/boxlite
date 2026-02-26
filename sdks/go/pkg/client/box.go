package client

import (
	"github.com/boxlite-ai/boxlite/sdks/go/internal/binding"
)

// Box is a handle to a running or stopped BoxLite box.
// Closing the handle does not remove the box; the box continues to exist in the runtime.
type Box struct {
	handle  boxProvider
	id      string
	name    string
	runtime *Runtime
}

// ID returns the unique identifier of the box.
func (b *Box) ID() string { return b.id }

// Name returns the user-defined name of the box.
func (b *Box) Name() string { return b.name }

// Start starts the box. The operation is idempotent.
func (b *Box) Start() error { return b.handle.Start() }

// Stop stops the box.
func (b *Box) Stop() error { return b.handle.Stop() }

// Info returns the current state and metadata of the box.
func (b *Box) Info() (binding.BoxInfo, error) {
	info, err := b.handle.Info()
	if err != nil {
		return binding.BoxInfo{}, err
	}
	return binding.BoxInfo{
		ID:        info.ID,
		Name:      info.Name,
		Image:     info.Image,
		State:     info.State,
		CreatedAt: info.CreatedAt,
	}, nil
}

// Exec executes a command inside the box and returns the result.
// If opts is nil, the command is executed with default options.
func (b *Box) Exec(command string, opts *ExecOptions) (*ExecResult, error) {
	bindOpts := binding.ExecOptions{}
	if opts != nil {
		bindOpts.Args = opts.Args
		bindOpts.Env = opts.Env
		bindOpts.TTY = opts.TTY
		bindOpts.User = opts.User
		bindOpts.WorkingDir = opts.WorkingDir
		if opts.Timeout > 0 {
			bindOpts.TimeoutSec = opts.Timeout.Seconds()
		}
	}

	result, err := b.handle.Exec(command, bindOpts)
	if err != nil {
		return nil, err
	}

	return &ExecResult{
		ExitCode: result.ExitCode,
		Stdout:   result.Stdout,
		Stderr:   result.Stderr,
	}, nil
}

// Close releases the box handle. The box itself is not removed from the runtime.
func (b *Box) Close() {
	if b.handle != nil {
		b.handle.Free()
		b.handle = nil
	}
}
