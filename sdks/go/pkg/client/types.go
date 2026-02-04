package client

import "time"

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
}

// BoxInfo contains information about a box.
type BoxInfo struct {
	ID        string    `json:"id"`
	Name      string    `json:"name,omitempty"`
	Image     string    `json:"image"`
	State     string    `json:"state"`
	CreatedAt time.Time `json:"created_at"`
}

// BoxState represents the state of a box.
type BoxState string

const (
	BoxStateConfigured BoxState = "configured"
	BoxStateRunning    BoxState = "running"
	BoxStateStopped    BoxState = "stopped"
	BoxStateError      BoxState = "error"
)
