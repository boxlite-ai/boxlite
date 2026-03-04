package client

import (
	"time"
)

// BoxOptions configures a new box.
type BoxOptions struct {
	// Image is the OCI image to use (e.g., "alpine:latest").
	Image string `json:"image"`

	// CPUs is the number of virtual CPUs (default: 1).
	CPUs int `json:"cpus,omitempty"`

	// MemoryMB is the memory limit in megabytes (default: 512).
	MemoryMB int `json:"memory_mb,omitempty"`

	// Env is a map of environment variables.
	Env map[string]string `json:"env,omitempty"`

	// WorkingDir is the working directory inside the container.
	WorkingDir string `json:"working_dir,omitempty"`

	// Command overrides the default command of the image.
	Command []string `json:"command,omitempty"`

	// Entrypoint overrides the default entrypoint of the image.
	Entrypoint []string `json:"entrypoint,omitempty"`

	// Mounts are volume mounts for the box.
	Mounts []Mount `json:"mounts,omitempty"`
}

// BoxOption is a functional option for configuring a Box.
type BoxOption func(*BoxOptions)

// Mount represents a volume mount.
type Mount struct {
	// Source is the path on the host.
	Source string `json:"source"`

	// Target is the path in the container.
	Target string `json:"target"`

	// Type is the mount type (e.g., "bind", "volume").
	Type string `json:"type,omitempty"`

	// ReadOnly makes the mount read-only.
	ReadOnly bool `json:"read_only,omitempty"`
}

// BoxInfo contains information about a box.
type BoxInfo struct {
	ID        string    `json:"id"`
	Name      string    `json:"name,omitempty"`
	Image     string    `json:"image"`
	State     string    `json:"state"`
	CreatedAt time.Time `json:"created_at"`
}

// ExecOptions holds options for executing a command in a box.
type ExecOptions struct {
	// Args is the argument list for the command.
	Args []string

	// Env is a map of environment variables to set.
	Env map[string]string

	// TTY enables pseudo-terminal allocation.
	TTY bool

	// User specifies the user to run the command as (e.g., "root", "1000:1000").
	User string

	// Timeout is the maximum duration for the command. Zero means no timeout.
	Timeout time.Duration

	// WorkingDir overrides the working directory for the command.
	WorkingDir string
}

// ExecResult holds the result of a command execution.
type ExecResult struct {
	// ExitCode is the process exit code.
	ExitCode int

	// Stdout contains the lines captured from standard output.
	Stdout []string

	// Stderr contains the lines captured from standard error.
	Stderr []string
}

// BoxState represents the state of a box.
type BoxState string

const (
	BoxStateConfigured BoxState = "configured"
	BoxStateRunning    BoxState = "running"
	BoxStateStopped    BoxState = "stopped"
	BoxStateError      BoxState = "error"
)

// RuntimeOptions represents configuration options for creating a Runtime.
type RuntimeOptions struct {
	// HomeDir is the directory where BoxLite stores its data.
	// If empty, uses the default location (~/.boxlite).
	HomeDir string

	// ImageRegistries is a list of OCI registries to use for image pulls.
	ImageRegistries []string
}

// WithImage sets the image for the box.
func WithImage(image string) BoxOption {
	return func(o *BoxOptions) { o.Image = image }
}

// WithCPUs sets the number of CPUs for the box.
func WithCPUs(cpus int) BoxOption {
	return func(o *BoxOptions) { o.CPUs = cpus }
}

// WithMemoryMB sets the memory limit in MB for the box.
func WithMemoryMB(memoryMB int) BoxOption {
	return func(o *BoxOptions) { o.MemoryMB = memoryMB }
}

// WithEnv sets environment variables for the box.
func WithEnv(env map[string]string) BoxOption {
	return func(o *BoxOptions) { o.Env = env }
}

// WithEnvVar adds a single environment variable to the box.
func WithEnvVar(key, value string) BoxOption {
	return func(o *BoxOptions) {
		if o.Env == nil {
			o.Env = make(map[string]string)
		}
		o.Env[key] = value
	}
}

// WithWorkingDir sets the working directory for the box.
func WithWorkingDir(workingDir string) BoxOption {
	return func(o *BoxOptions) { o.WorkingDir = workingDir }
}

// WithCommand sets the command for the box.
func WithCommand(command ...string) BoxOption {
	return func(o *BoxOptions) { o.Command = command }
}

// WithEntrypoint sets the entrypoint for the box.
func WithEntrypoint(entrypoint ...string) BoxOption {
	return func(o *BoxOptions) { o.Entrypoint = entrypoint }
}

// WithMounts sets the mounts for the box.
func WithMounts(mounts ...Mount) BoxOption {
	return func(o *BoxOptions) { o.Mounts = mounts }
}

// WithMount adds a single mount to the box.
func WithMount(source, target string, readOnly bool) BoxOption {
	return func(o *BoxOptions) {
		mount := Mount{
			Source:   source,
			Target:   target,
			Type:     "bind",
			ReadOnly: readOnly,
		}
		o.Mounts = append(o.Mounts, mount)
	}
}

// NewBoxOptions creates a new BoxOptions with the given image and optional configurations.
func NewBoxOptions(image string, opts ...BoxOption) BoxOptions {
	o := BoxOptions{Image: image}
	for _, opt := range opts {
		opt(&o)
	}
	return o
}
