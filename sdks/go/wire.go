package boxlite

import (
	"fmt"
	"time"
)

// Wire types match the JSON format produced by the Rust FFI layer.
// These are unexported — only used for JSON marshaling/unmarshaling.

// boxOptionsWire matches Rust BoxOptions JSON format.
type boxOptionsWire struct {
	Rootfs     any          `json:"rootfs"`
	CPUs       *int         `json:"cpus,omitempty"`
	MemoryMiB  *int         `json:"memory_mib,omitempty"`
	Env        [][2]string  `json:"env"`
	Volumes    []wireVol    `json:"volumes"`
	Network    any          `json:"network"`
	Ports      []wirePort   `json:"ports"`
	WorkDir    string       `json:"working_dir,omitempty"`
	AutoRemove *bool        `json:"auto_remove,omitempty"`
	Detach     *bool        `json:"detach,omitempty"`
	Entrypoint []string     `json:"entrypoint,omitempty"`
	Cmd        []string     `json:"cmd,omitempty"`
	Secrets    []wireSecret `json:"secrets"`
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

type wireNetworkSpec struct {
	Mode     string   `json:"mode"`
	AllowNet []string `json:"allow_net,omitempty"`
}

type wireSecret struct {
	Name        string   `json:"name"`
	Hosts       []string `json:"hosts"`
	Placeholder string   `json:"placeholder"`
	Value       string   `json:"value"`
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
func buildOptionsJSON(image string, cfg *boxConfig) (boxOptionsWire, error) {
	w := boxOptionsWire{
		Rootfs: wireRootfsImage{Image: image},
		Env:    cfg.env,
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

	network := NetworkSpec{
		Mode: NetworkModeEnabled,
	}
	if cfg.network != nil {
		network = *cfg.network
	}
	allowNet := network.AllowNet
	if allowNet == nil {
		allowNet = []string{}
	}
	switch network.Mode {
	case "", NetworkModeEnabled:
		w.Network = wireNetworkSpec{
			Mode:     string(NetworkModeEnabled),
			AllowNet: allowNet,
		}
	case NetworkModeDisabled:
		if len(allowNet) > 0 {
			return boxOptionsWire{}, fmt.Errorf(
				"network.mode=%q is incompatible with allow_net", NetworkModeDisabled,
			)
		}
		w.Network = wireNetworkSpec{Mode: string(NetworkModeDisabled)}
	default:
		return boxOptionsWire{}, fmt.Errorf(
			"invalid network mode %q: expected %q or %q",
			network.Mode,
			NetworkModeEnabled,
			NetworkModeDisabled,
		)
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
	for _, secret := range cfg.secrets {
		placeholder := secret.Placeholder
		if placeholder == "" {
			placeholder = "<BOXLITE_SECRET:" + secret.Name + ">"
		}
		hosts := secret.Hosts
		if hosts == nil {
			hosts = []string{}
		}
		w.Secrets = append(w.Secrets, wireSecret{
			Name:        secret.Name,
			Hosts:       hosts,
			Placeholder: placeholder,
			Value:       secret.Value,
		})
	}
	if w.Secrets == nil {
		w.Secrets = []wireSecret{}
	}

	return w, nil
}
