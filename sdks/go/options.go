package boxlite

// RuntimeOption configures a Runtime.
type RuntimeOption func(*runtimeConfig)

type runtimeConfig struct {
	homeDir    string
	registries []string
}

// WithHomeDir sets the BoxLite data directory.
func WithHomeDir(dir string) RuntimeOption {
	return func(c *runtimeConfig) { c.homeDir = dir }
}

// WithRegistries sets the OCI registries to use for image pulls.
func WithRegistries(registries ...string) RuntimeOption {
	return func(c *runtimeConfig) { c.registries = registries }
}

// BoxOption configures a Box.
type BoxOption func(*boxConfig)

type NetworkMode string

const (
	NetworkModeEnabled  NetworkMode = "enabled"
	NetworkModeDisabled NetworkMode = "disabled"
)

type NetworkSpec struct {
	Mode     NetworkMode
	AllowNet []string
}

// Secret configures outbound HTTPS secret substitution.
type Secret struct {
	Name        string
	Value       string
	Hosts       []string
	Placeholder string
}

type boxConfig struct {
	name       string
	cpus       int
	memoryMiB  int
	env        [][2]string
	volumes    []volumeEntry
	workDir    string
	entrypoint []string
	cmd        []string
	autoRemove *bool
	detach     *bool
	network    *NetworkSpec
	secrets    []Secret
}

type volumeEntry struct {
	hostPath  string
	guestPath string
	readOnly  bool
}

// WithName sets a human-readable name for the box.
func WithName(name string) BoxOption {
	return func(c *boxConfig) { c.name = name }
}

// WithCPUs sets the number of virtual CPUs.
func WithCPUs(n int) BoxOption {
	return func(c *boxConfig) { c.cpus = n }
}

// WithMemory sets the memory limit in MiB.
func WithMemory(mib int) BoxOption {
	return func(c *boxConfig) { c.memoryMiB = mib }
}

// WithEnv adds an environment variable.
func WithEnv(key, value string) BoxOption {
	return func(c *boxConfig) {
		c.env = append(c.env, [2]string{key, value})
	}
}

// WithVolume mounts a host path into the box.
func WithVolume(hostPath, containerPath string) BoxOption {
	return func(c *boxConfig) {
		c.volumes = append(c.volumes, volumeEntry{hostPath, containerPath, false})
	}
}

// WithVolumeReadOnly mounts a host path into the box as read-only.
func WithVolumeReadOnly(hostPath, containerPath string) BoxOption {
	return func(c *boxConfig) {
		c.volumes = append(c.volumes, volumeEntry{hostPath, containerPath, true})
	}
}

// WithWorkDir sets the working directory inside the container.
func WithWorkDir(dir string) BoxOption {
	return func(c *boxConfig) { c.workDir = dir }
}

// WithEntrypoint overrides the image's ENTRYPOINT.
func WithEntrypoint(args ...string) BoxOption {
	return func(c *boxConfig) { c.entrypoint = args }
}

// WithCmd overrides the image's CMD.
func WithCmd(args ...string) BoxOption {
	return func(c *boxConfig) { c.cmd = args }
}

// WithNetwork sets the structured network configuration for the box.
func WithNetwork(spec NetworkSpec) BoxOption {
	return func(c *boxConfig) {
		allowNet := append([]string(nil), spec.AllowNet...)
		c.network = &NetworkSpec{
			Mode:     spec.Mode,
			AllowNet: allowNet,
		}
	}
}

// WithSecret adds an outbound HTTPS secret substitution rule.
func WithSecret(secret Secret) BoxOption {
	return func(c *boxConfig) {
		c.secrets = append(c.secrets, secret)
	}
}

// WithAutoRemove sets whether the box is auto-removed on stop.
func WithAutoRemove(v bool) BoxOption {
	return func(c *boxConfig) { c.autoRemove = &v }
}

// WithDetach sets whether the box survives parent process exit.
func WithDetach(v bool) BoxOption {
	return func(c *boxConfig) { c.detach = &v }
}
