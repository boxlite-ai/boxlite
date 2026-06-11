package boxlite

/*
#include "boxlite.h"
#include <stdlib.h>
*/
import "C"
import (
	"fmt"
	"os"
	"strings"
	"unsafe"
)

// RuntimeOption configures a Runtime.
type RuntimeOption func(*runtimeConfig)

type runtimeConfig struct {
	homeDir         string
	imageRegistries []ImageRegistry
}

// RegistryTransport selects the transport used to contact an OCI registry.
type RegistryTransport string

const (
	RegistryTransportHTTPS RegistryTransport = "https"
	RegistryTransportHTTP  RegistryTransport = "http"
)

// ImageRegistryAuth configures credentials for an OCI registry.
type ImageRegistryAuth struct {
	Username    string
	Password    string
	BearerToken string
}

// ImageRegistry configures an OCI registry host.
type ImageRegistry struct {
	Host       string
	Transport  RegistryTransport
	SkipVerify bool
	Search     bool
	Auth       ImageRegistryAuth
}

// WithHomeDir sets the BoxLite data directory.
func WithHomeDir(dir string) RuntimeOption {
	return func(c *runtimeConfig) { c.homeDir = dir }
}

// WithImageRegistry configures transport, TLS, search, and auth for a registry.
func WithImageRegistry(registry ImageRegistry) RuntimeOption {
	return func(c *runtimeConfig) { c.imageRegistries = append(c.imageRegistries, registry) }
}

// WithImageRegistries configures multiple image registries.
func WithImageRegistries(registries ...ImageRegistry) RuntimeOption {
	return func(c *runtimeConfig) { c.imageRegistries = append(c.imageRegistries, registries...) }
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

// PortProtocol selects the protocol used for a port forwarding rule.
type PortProtocol uint8

const (
	PortProtocolInvalid PortProtocol = iota
	PortProtocolTCP
	PortProtocolUDP
)

func (p PortProtocol) String() string {
	switch p {
	case PortProtocolTCP:
		return "tcp"
	case PortProtocolUDP:
		return "udp"
	default:
		return fmt.Sprintf("unknown(%d)", p)
	}
}

// PortSpec configures a host-to-guest port forwarding rule.
type PortSpec struct {
	Host     int
	Guest    int
	Protocol PortProtocol
	HostIP   string
}

type cPortSpec struct {
	host_port  int
	guest_port int
	protocol   PortProtocol
	host_ip    string
}

func (p PortSpec) toCSpec() (cPortSpec, error) {
	switch p.Protocol {
	case PortProtocolTCP, PortProtocolUDP:
	default:
		return cPortSpec{}, fmt.Errorf("invalid port protocol %s", p.Protocol)
	}

	return cPortSpec{
		host_port:  p.Host,
		guest_port: p.Guest,
		protocol:   p.Protocol,
		host_ip:    p.HostIP,
	}, nil
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
	diskSizeGB int
	rootfsPath string
	env        [][2]string
	volumes    []volumeEntry
	ports      []PortSpec
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

// WithDiskSize sets the per-box COW disk virtual size in GB.
// When unset, the COW disk inherits the base ext4 image size, which is
// content-fitted (~256 MB minimum). Set this to give the sandbox runtime
// write headroom; the guest's ext4 is automatically resized via resize2fs
// on first boot.
func WithDiskSize(gb int) BoxOption {
	return func(c *boxConfig) { c.diskSizeGB = gb }
}

// WithRootfsPath prefers a local OCI image layout directory over pulling from a registry.
//
// If the path exists and is a directory, it is used and the image argument to
// [Runtime.Create] is ignored. Otherwise BoxLite falls back to the image reference
// (for example when the directory has not been exported yet).
//
// The directory should contain a valid OCI bundle (oci-layout, index.json, blobs/sha256/, …).
func WithRootfsPath(path string) BoxOption {
	return func(c *boxConfig) { c.rootfsPath = path }
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

// WithPort forwards a host port to a guest port. A host of 0 lets the runtime
// assign one dynamically.
func WithPort(host, guest int) BoxOption {
	return WithPortSpec(PortSpec{
		Host:     host,
		Guest:    guest,
		Protocol: PortProtocolTCP,
	})
}

// WithPortSpec forwards a host port to a guest port with explicit bind settings.
func WithPortSpec(spec PortSpec) BoxOption {
	return func(c *boxConfig) {
		c.ports = append(c.ports, spec)
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

func buildCOptions(image string, cfg *boxConfig) (*C.CBoxliteOptions, error) {
	image = strings.TrimSpace(image)
	rootfsPath := strings.TrimSpace(cfg.rootfsPath)

	useLocalOCI := false
	if rootfsPath != "" {
		if fi, err := os.Stat(rootfsPath); err == nil && fi.IsDir() {
			useLocalOCI = true
		}
	}
	if image == "" && !useLocalOCI {
		return nil, fmt.Errorf("boxlite: image reference is required when WithRootfsPath is unset, missing, or not a directory")
	}

	cImage := toCString(image)
	defer C.free(unsafe.Pointer(cImage))

	var cOpts *C.CBoxliteOptions
	var cerr C.CBoxliteError
	code := C.boxlite_options_new(cImage, &cOpts, &cerr)
	if code != C.Ok {
		return nil, freeError(&cerr)
	}

	if useLocalOCI {
		cPath := toCString(rootfsPath)
		C.boxlite_options_set_rootfs_path(cOpts, cPath)
		C.free(unsafe.Pointer(cPath))
	}
	if cfg.name != "" {
		cName := toCString(cfg.name)
		C.boxlite_options_set_name(cOpts, cName)
		C.free(unsafe.Pointer(cName))
	}
	if cfg.cpus > 0 {
		C.boxlite_options_set_cpus(cOpts, C.int(cfg.cpus))
	}
	if cfg.memoryMiB > 0 {
		C.boxlite_options_set_memory(cOpts, C.int(cfg.memoryMiB))
	}
	if cfg.diskSizeGB > 0 {
		C.boxlite_options_set_disk_size_gb(cOpts, C.int(cfg.diskSizeGB))
	}
	if cfg.workDir != "" {
		cDir := toCString(cfg.workDir)
		C.boxlite_options_set_workdir(cOpts, cDir)
		C.free(unsafe.Pointer(cDir))
	}
	for _, env := range cfg.env {
		cKey := toCString(env[0])
		cValue := toCString(env[1])
		C.boxlite_options_add_env(cOpts, cKey, cValue)
		C.free(unsafe.Pointer(cKey))
		C.free(unsafe.Pointer(cValue))
	}
	for _, volume := range cfg.volumes {
		cHost := toCString(volume.hostPath)
		cGuest := toCString(volume.guestPath)
		readOnly := C.int(0)
		if volume.readOnly {
			readOnly = 1
		}
		C.boxlite_options_add_volume(cOpts, cHost, cGuest, readOnly)
		C.free(unsafe.Pointer(cHost))
		C.free(unsafe.Pointer(cGuest))
	}
	for _, port := range cfg.ports {
		cPort, err := port.toCSpec()
		if err != nil {
			C.boxlite_options_free(cOpts)
			return nil, err
		}
		C.boxlite_options_add_port(cOpts, C.int(cPort.guest_port), C.int(cPort.host_port))
	}
	if cfg.network != nil {
		switch cfg.network.Mode {
		case "", NetworkModeEnabled:
			C.boxlite_options_set_network_enabled(cOpts)
			for _, host := range cfg.network.AllowNet {
				cHost := toCString(host)
				C.boxlite_options_add_network_allow(cOpts, cHost)
				C.free(unsafe.Pointer(cHost))
			}
		case NetworkModeDisabled:
			if len(cfg.network.AllowNet) > 0 {
				C.boxlite_options_free(cOpts)
				return nil, fmt.Errorf("network.mode=%q is incompatible with allow_net", NetworkModeDisabled)
			}
			C.boxlite_options_set_network_disabled(cOpts)
		default:
			C.boxlite_options_free(cOpts)
			return nil, fmt.Errorf("invalid network mode %q", cfg.network.Mode)
		}
	}
	for _, secret := range cfg.secrets {
		cName := toCString(secret.Name)
		cValue := toCString(secret.Value)
		placeholder := secret.Placeholder
		if placeholder == "" {
			placeholder = "<BOXLITE_SECRET:" + secret.Name + ">"
		}
		cPlaceholder := toCString(placeholder)
		cHosts, hostCount := toCStringArray(secret.Hosts)
		C.boxlite_options_add_secret(cOpts, cName, cValue, cPlaceholder, cHosts, C.int(hostCount))
		freeCStringArray(cHosts, hostCount)
		C.free(unsafe.Pointer(cName))
		C.free(unsafe.Pointer(cValue))
		C.free(unsafe.Pointer(cPlaceholder))
	}
	if cfg.autoRemove != nil {
		C.boxlite_options_set_auto_remove(cOpts, boolToCInt(*cfg.autoRemove))
	}
	if cfg.detach != nil {
		C.boxlite_options_set_detach(cOpts, boolToCInt(*cfg.detach))
	}
	if cfg.entrypoint != nil {
		cArgs, argc := toCStringArray(cfg.entrypoint)
		C.boxlite_options_set_entrypoint(cOpts, cArgs, C.int(argc))
		freeCStringArray(cArgs, argc)
	}
	if cfg.cmd != nil {
		cArgs, argc := toCStringArray(cfg.cmd)
		C.boxlite_options_set_cmd(cOpts, cArgs, C.int(argc))
		freeCStringArray(cArgs, argc)
	}

	return cOpts, nil
}

func boolToCInt(v bool) C.int {
	if v {
		return 1
	}
	return 0
}
