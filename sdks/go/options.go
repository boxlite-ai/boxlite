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

type boxConfig struct {
	name       string
	cpus       int
	memoryMiB  int
	diskSizeGB int64
	user       string
	env        [][2]string
	volumes    []volumeEntry
	ports      []portEntry
	network    *NetworkSpec
	workDir    string
	entrypoint []string
	cmd        []string
	autoRemove *bool
	detach     *bool
}

type portEntry struct {
	hostPort  *int
	guestPort int
	protocol  string
}

// NetworkSpec controls the box's network configuration.
type NetworkSpec struct {
	mode     string   // "enabled", "disabled", "isolated"
	allowNet []string // only used when mode == "enabled"
}

// NetworkEnabled returns a NetworkSpec with full network access.
func NetworkEnabled() NetworkSpec {
	return NetworkSpec{mode: "enabled"}
}

// NetworkEnabledWithAllowList returns a NetworkSpec that only allows specific hosts.
func NetworkEnabledWithAllowList(hosts ...string) NetworkSpec {
	return NetworkSpec{mode: "enabled", allowNet: hosts}
}

// NetworkDisabled returns a NetworkSpec with no network access.
func NetworkDisabled() NetworkSpec {
	return NetworkSpec{mode: "disabled"}
}

// NetworkIsolated returns a NetworkSpec with isolated (default) network.
func NetworkIsolated() NetworkSpec {
	return NetworkSpec{mode: "isolated"}
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

// WithAutoRemove sets whether the box is auto-removed on stop.
func WithAutoRemove(v bool) BoxOption {
	return func(c *boxConfig) { c.autoRemove = &v }
}

// WithDetach sets whether the box survives parent process exit.
func WithDetach(v bool) BoxOption {
	return func(c *boxConfig) { c.detach = &v }
}

// WithDiskSize sets the disk size in GB.
func WithDiskSize(gb int64) BoxOption {
	return func(c *boxConfig) { c.diskSizeGB = gb }
}

// WithUser sets the user to run as inside the box (e.g., "root", "1000:1000").
func WithUser(spec string) BoxOption {
	return func(c *boxConfig) { c.user = spec }
}

// WithNetwork sets the network configuration for the box.
func WithNetwork(spec NetworkSpec) BoxOption {
	return func(c *boxConfig) { c.network = &spec }
}

// WithPort adds a port mapping from host to guest.
// If hostPort is 0, a port will be dynamically assigned.
func WithPort(guestPort int, hostPort int) BoxOption {
	return func(c *boxConfig) {
		entry := portEntry{guestPort: guestPort, protocol: "tcp"}
		if hostPort > 0 {
			entry.hostPort = &hostPort
		}
		c.ports = append(c.ports, entry)
	}
}
