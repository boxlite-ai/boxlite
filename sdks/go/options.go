package boxlite

/*
#include "boxlite.h"
#include <stdlib.h>
*/
import "C"
import (
	"encoding/json"
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

// Secret configures outbound HTTPS secret substitution.
type Secret struct {
	Name        string
	Value       string
	Hosts       []string
	Placeholder string
}

// SecurityResourceLimits specifies process resource limits for a box.
type SecurityResourceLimits struct {
	MaxOpenFiles *uint64 `json:"max_open_files,omitempty"`
	MaxFileSize  *uint64 `json:"max_file_size,omitempty"`
	MaxProcesses *uint64 `json:"max_processes,omitempty"`
	MaxMemory    *uint64 `json:"max_memory,omitempty"`
	MaxCpuTime   *uint64 `json:"max_cpu_time,omitempty"`
}

// SecurityOptions controls how the boxlite-shim process is isolated from the host.
// All fields are optional; unset fields inherit the platform default.
// JSON tags use snake_case to match Rust SecurityOptions serde field names.
type SecurityOptions struct {
	Preset         *string                 `json:"preset,omitempty"`
	JailerEnabled  *bool                   `json:"jailer_enabled,omitempty"`
	SeccompEnabled *bool                   `json:"seccomp_enabled,omitempty"`
	UID            *uint32                 `json:"uid,omitempty"`
	GID            *uint32                 `json:"gid,omitempty"`
	NewPIDNS       *bool                   `json:"new_pid_ns,omitempty"`
	NewNetNS       *bool                   `json:"new_net_ns,omitempty"`
	ChrootBase     *string                 `json:"chroot_base,omitempty"`
	ChrootEnabled  *bool                   `json:"chroot_enabled,omitempty"`
	CloseFDs       *bool                   `json:"close_fds,omitempty"`
	SanitizeEnv    *bool                   `json:"sanitize_env,omitempty"`
	EnvAllowlist   *[]string               `json:"env_allowlist,omitempty"`
	ResourceLimits *SecurityResourceLimits `json:"resource_limits,omitempty"`
	SandboxProfile *string                 `json:"sandbox_profile,omitempty"`
	NetworkEnabled *bool                   `json:"network_enabled,omitempty"`
}

type boxConfig struct {
	name       string
	cpus       int
	memoryMiB  int
	diskSizeGB int
	rootfsPath string
	env        [][2]string
	volumes    []volumeEntry
	workDir    string
	entrypoint []string
	cmd        []string
	autoRemove *bool
	detach     *bool
	network    *NetworkSpec
	secrets    []Secret
	security   *SecurityOptions
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

// WithSecurity sets the security isolation options for the box.
func WithSecurity(sec SecurityOptions) BoxOption {
	return func(c *boxConfig) { c.security = &sec }
}

// presetDefaults returns the concrete SecurityOptions fields for a named preset.
// The "preset" string field is not a Rust SecurityOptions wire field; callers
// must expand it into concrete fields before JSON serialization.
// Returns an error for unrecognized preset names so that typos surface
// immediately rather than silently falling back to "standard" isolation.
func presetDefaults(preset string) (SecurityOptions, error) {
	t := func(b bool) *bool { return &b }
	u := func(v uint64) *uint64 { return &v }
	switch preset {
	case "development":
		return SecurityOptions{
			JailerEnabled:  t(false),
			SeccompEnabled: t(false),
			CloseFDs:       t(false),
			SanitizeEnv:    t(false),
			NetworkEnabled: t(true),
		}, nil
	case "maximum":
		return SecurityOptions{
			JailerEnabled:  t(true),
			SeccompEnabled: t(true),
			CloseFDs:       t(true),
			SanitizeEnv:    t(true),
			NetworkEnabled: t(true),
			ResourceLimits: &SecurityResourceLimits{
				MaxOpenFiles: u(1024),
				MaxFileSize:  u(1073741824),
				MaxProcesses: u(100),
			},
		}, nil
	case "standard":
		return SecurityOptions{
			JailerEnabled:  t(true),
			SeccompEnabled: t(false),
			CloseFDs:       t(true),
			SanitizeEnv:    t(true),
			NetworkEnabled: t(true),
		}, nil
	default:
		return SecurityOptions{}, fmt.Errorf("boxlite: unknown security preset %q: valid values are development, standard, maximum", preset)
	}
}

// mergeSecurityOptions merges explicit overrides on top of base, mutating base.
// Any non-nil field in overrides replaces the corresponding field in base.
func mergeSecurityOptions(base, overrides *SecurityOptions) {
	if overrides.JailerEnabled != nil {
		base.JailerEnabled = overrides.JailerEnabled
	}
	if overrides.SeccompEnabled != nil {
		base.SeccompEnabled = overrides.SeccompEnabled
	}
	if overrides.UID != nil {
		base.UID = overrides.UID
	}
	if overrides.GID != nil {
		base.GID = overrides.GID
	}
	if overrides.NewPIDNS != nil {
		base.NewPIDNS = overrides.NewPIDNS
	}
	if overrides.NewNetNS != nil {
		base.NewNetNS = overrides.NewNetNS
	}
	if overrides.ChrootBase != nil {
		base.ChrootBase = overrides.ChrootBase
	}
	if overrides.ChrootEnabled != nil {
		base.ChrootEnabled = overrides.ChrootEnabled
	}
	if overrides.CloseFDs != nil {
		base.CloseFDs = overrides.CloseFDs
	}
	if overrides.SanitizeEnv != nil {
		base.SanitizeEnv = overrides.SanitizeEnv
	}
	if overrides.EnvAllowlist != nil {
		base.EnvAllowlist = overrides.EnvAllowlist
	}
	if overrides.ResourceLimits != nil {
		base.ResourceLimits = overrides.ResourceLimits
	}
	if overrides.SandboxProfile != nil {
		base.SandboxProfile = overrides.SandboxProfile
	}
	if overrides.NetworkEnabled != nil {
		base.NetworkEnabled = overrides.NetworkEnabled
	}
}

// expandSecurityPreset resolves cfg.security.Preset into concrete fields.
// The Preset string is NOT a Rust SecurityOptions wire field; Rust ignores it.
// Any explicit fields in the original options override preset defaults.
// Returns an error if the preset name is not one of the known values.
func expandSecurityPreset(sec *SecurityOptions) (*SecurityOptions, error) {
	if sec == nil || sec.Preset == nil {
		return sec, nil
	}
	// Capture explicit overrides before we clear Preset.
	overrides := *sec
	overrides.Preset = nil

	// Start from preset defaults, then apply explicit overrides.
	expanded, err := presetDefaults(*sec.Preset)
	if err != nil {
		return nil, err
	}
	mergeSecurityOptions(&expanded, &overrides)
	return &expanded, nil
}

// WithSecurityPreset sets a named security preset (development, standard, maximum).
// Explicit WithSecurity options take precedence over preset defaults.
// The preset is expanded into concrete fields before serialization so that
// the Rust runtime receives only the fields it knows about.
func WithSecurityPreset(preset string) BoxOption {
	return func(c *boxConfig) {
		if c.security == nil {
			c.security = &SecurityOptions{}
		}
		c.security.Preset = &preset
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
	if cfg.security != nil {
		// Resolve any named preset into concrete fields before serialization.
		// The "preset" key is not a Rust SecurityOptions wire field and would
		// be silently dropped by serde, leaving the caller with no isolation.
		sec, err := expandSecurityPreset(cfg.security)
		if err != nil {
			C.boxlite_options_free(cOpts)
			return nil, err
		}
		secJSON, err := json.Marshal(sec)
		if err == nil {
			cJSON := toCString(string(secJSON))
			C.boxlite_options_set_security_json(cOpts, cJSON)
			C.free(unsafe.Pointer(cJSON))
		}
	}

	return cOpts, nil
}

func boolToCInt(v bool) C.int {
	if v {
		return 1
	}
	return 0
}
