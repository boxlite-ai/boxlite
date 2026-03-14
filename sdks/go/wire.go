package boxlite

import "time"

// Wire types match the JSON format produced by the Rust FFI layer.
// These are unexported — only used for JSON marshaling/unmarshaling.

// boxOptionsWire matches Rust BoxOptions JSON format.
type boxOptionsWire struct {
	Rootfs     any         `json:"rootfs"`
	CPUs       *int        `json:"cpus,omitempty"`
	MemoryMiB  *int        `json:"memory_mib,omitempty"`
	Env        [][2]string `json:"env"`
	Volumes    []wireVol   `json:"volumes"`
	Network    string      `json:"network"`
	Ports      []wirePort  `json:"ports"`
	WorkDir    string      `json:"working_dir,omitempty"`
	AutoRemove *bool       `json:"auto_remove,omitempty"`
	Detach     *bool       `json:"detach,omitempty"`
	Entrypoint []string    `json:"entrypoint,omitempty"`
	Cmd        []string    `json:"cmd,omitempty"`
}

type wireVol struct {
	HostPath  string `json:"host_path"`
	GuestPath string `json:"guest_path"`
	ReadOnly  bool   `json:"read_only"`
}

type wirePort struct {
	HostPort  *int   `json:"host_port,omitempty"`
	GuestPort int    `json:"guest_port"`
	Protocol  string `json:"protocol"`
}

// wireRootfsImage matches Rust RootfsSpec::Image serialization.
type wireRootfsImage struct {
	Image string `json:"Image"`
}

// boxInfoWire matches the JSON from box_info_to_json() in ffi/src/json.rs.
type boxInfoWire struct {
	ID        string        `json:"id"`
	Name      string        `json:"name"`
	State     wireStateInfo `json:"state"`
	Image     string        `json:"image"`
	CPUs      int           `json:"cpus"`
	MemoryMiB int           `json:"memory_mib"`
	CreatedAt time.Time     `json:"created_at"`
}

type wireStateInfo struct {
	Status  string `json:"status"`
	Running bool   `json:"running"`
	PID     *int   `json:"pid"`
}

func (w *boxInfoWire) toBoxInfo() BoxInfo {
	pid := 0
	if w.State.PID != nil {
		pid = *w.State.PID
	}
	return BoxInfo{
		ID:        w.ID,
		Name:      w.Name,
		Image:     w.Image,
		State:     State(w.State.Status),
		Running:   w.State.Running,
		PID:       pid,
		CPUs:      w.CPUs,
		MemoryMiB: w.MemoryMiB,
		CreatedAt: w.CreatedAt,
	}
}

// buildOptionsJSON creates the JSON wire representation from boxConfig.
func buildOptionsJSON(image string, cfg *boxConfig) boxOptionsWire {
	w := boxOptionsWire{
		Rootfs:  wireRootfsImage{Image: image},
		Env:     cfg.env,
		Network: "Isolated",
	}

	if w.Env == nil {
		w.Env = [][2]string{}
	}

	if cfg.cpus > 0 {
		w.CPUs = &cfg.cpus
	}
	if cfg.memoryMiB > 0 {
		w.MemoryMiB = &cfg.memoryMiB
	}
	if cfg.workDir != "" {
		w.WorkDir = cfg.workDir
	}
	if cfg.autoRemove != nil {
		w.AutoRemove = cfg.autoRemove
	}
	if cfg.detach != nil {
		w.Detach = cfg.detach
	}
	if cfg.entrypoint != nil {
		w.Entrypoint = cfg.entrypoint
	}
	if cfg.cmd != nil {
		w.Cmd = cfg.cmd
	}

	for _, v := range cfg.volumes {
		w.Volumes = append(w.Volumes, wireVol{
			HostPath:  v.hostPath,
			GuestPath: v.guestPath,
			ReadOnly:  v.readOnly,
		})
	}

	if w.Volumes == nil {
		w.Volumes = []wireVol{}
	}
	if w.Ports == nil {
		w.Ports = []wirePort{}
	}

	return w
}
