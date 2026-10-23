// Package api holds the wire types shared by the supervisor's packages: the Spec
// JSON from contracts.md section 0, the /sv/v1/* request bodies of section 2.2 and
// the gateway responses of section 2.3. Nothing here has behaviour beyond JSON
// shape and a few derived accessors, so every other package can import it.
package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"
)

// Service states and health values as enumerated in contracts.md 2.3.
const (
	StateRunning    = "running"
	StateStarting   = "starting"
	StateRestarting = "restarting"
	StateStopped    = "stopped"
	StateFailed     = "failed"

	HealthHealthy   = "healthy"
	HealthUnhealthy = "unhealthy"
	HealthStarting  = "starting"
	HealthNone      = "none"
)

// Deployment phases reported to POST /sv/v1/status (contracts.md 2.2/2.4).
const (
	PhaseBuilding = "building"
	PhaseBuilt    = "built"
	PhaseStarting = "starting"
	PhaseLive     = "live"
	PhaseFailed   = "failed"
)

// Log sources and levels for POST /sv/v1/logs. Service lines use the service name
// as their source.
const (
	SourceBuild  = "build"
	SourceSystem = "system"

	LevelInfo  = "info"
	LevelError = "error"
)

// ProtocolVersion is reported as `version` by GET /.boxlite/sv/health. The
// control plane compares it to decide whether a Box runs a supervisor that
// predates a wire change and must be restarted to fetch the current binary.
//
//	1  (no `version` field) one gateway secret for everything, runs as boxlite
//	2  forward/control secret split, supervisor runs as root, services as boxlite
const ProtocolVersion = 2

// Errors the deploy manager returns to the gateway, which maps them to HTTP codes.
var (
	ErrBusy      = errors.New("a deploy or activation is already in progress")
	ErrNoRelease = errors.New("no such release on this box")
	ErrNotBuilt  = errors.New("release is not built")
	ErrNoService = errors.New("no such service")
	// ErrShuttingDown: the supervisor received SIGTERM and starts nothing new.
	ErrShuttingDown = errors.New("the supervisor is shutting down")
)

// Spec is the subset of the Spec JSON (contracts.md section 0) the supervisor acts on.
type Spec struct {
	App         string    `json:"app"`
	Environment string    `json:"environment"`
	Version     int       `json:"version"`
	Deployment  int       `json:"deployment"`
	Runtime     Runtime   `json:"runtime"`
	Services    []Service `json:"services"`
	Volumes     []Volume  `json:"volumes,omitempty"`
}

// Volume is one [[volume]] entry; the supervisor only needs its mount point.
type Volume struct {
	Name  string `json:"name"`
	Mount string `json:"mount"`
}

// Runtime is the [runtime] table of boxlite.toml.
type Runtime struct {
	Image string   `json:"image"`
	Size  string   `json:"size"`
	Build []string `json:"build"`
}

// Service is one [[service]] entry. Exactly one of Command/Static is set.
type Service struct {
	Name    string   `json:"name"`
	Command string   `json:"command,omitempty"`
	Port    PortHint `json:"port,omitzero"`
	Health  string   `json:"health,omitempty"`
	Static  string   `json:"static,omitempty"`
}

// PortHint accepts `true`, `false`, `null` or an integer for a service's `port`.
// Any true/integer value marks the service as exposed; the integer itself is only
// a hint from the manifest because the supervisor always assigns PORT (section 0).
type PortHint struct {
	Exposed bool
	Hint    int
}

// IsZero lets `omitzero` drop the field for non-exposed services.
func (p PortHint) IsZero() bool { return !p.Exposed }

// UnmarshalJSON implements json.Unmarshaler.
func (p *PortHint) UnmarshalJSON(b []byte) error {
	var v any
	if err := json.Unmarshal(b, &v); err != nil {
		return err
	}
	switch t := v.(type) {
	case nil:
		*p = PortHint{}
	case bool:
		*p = PortHint{Exposed: t}
	case float64:
		*p = PortHint{Exposed: true, Hint: int(t)}
	default:
		return fmt.Errorf("port: expected bool or integer, got %T", v)
	}
	return nil
}

// MarshalJSON implements json.Marshaler.
func (p PortHint) MarshalJSON() ([]byte, error) {
	switch {
	case !p.Exposed:
		return []byte("null"), nil
	case p.Hint > 0:
		return []byte(strconv.Itoa(p.Hint)), nil
	default:
		return []byte("true"), nil
	}
}

// IsStatic reports whether the service is a static file server rather than a process.
func (s Service) IsStatic() bool { return s.Static != "" }

// IsExposedCandidate reports whether the service may be the exposed one.
func (s Service) IsExposedCandidate() bool { return s.Port.Exposed || s.IsStatic() }

// HealthPath is the probe path for an exposed command service; contracts.md
// section 0 defaults it to "/". Static services are never probed.
func (s Service) HealthPath() string {
	if s.IsStatic() {
		return ""
	}
	if s.Health == "" {
		return "/"
	}
	return s.Health
}

// Exposed returns the exposed service: the first with a port or a static path.
func (s Spec) Exposed() (Service, bool) {
	for _, svc := range s.Services {
		if svc.IsExposedCandidate() {
			return svc, true
		}
	}
	return Service{}, false
}

// Validate applies the structural rules the supervisor depends on. The CLI and
// the control plane already check the manifest; this guards against a malformed
// spec reaching the box and producing confusing process errors.
func (s Spec) Validate() error {
	seen := map[string]bool{}
	for i, svc := range s.Services {
		if svc.Name == "" {
			return fmt.Errorf("services[%d]: missing name", i)
		}
		if seen[svc.Name] {
			return fmt.Errorf("services[%d]: duplicate name %q", i, svc.Name)
		}
		seen[svc.Name] = true
		switch {
		case svc.IsStatic() && svc.Command != "":
			return fmt.Errorf("service %q: static services take no command", svc.Name)
		case !svc.IsStatic() && svc.Command == "":
			return fmt.Errorf("service %q: missing command", svc.Name)
		}
	}
	return nil
}

// SpecResponse is the body of GET /sv/v1/spec (contracts.md 2.2).
//
// ForwardSecret authenticates proxied end-user traffic and nothing else;
// ControlSecret authenticates the control plane's /.boxlite/sv/* calls.
type SpecResponse struct {
	Spec          Spec              `json:"spec"`
	Deployment    int               `json:"deployment"`
	ForwardSecret string            `json:"forward_secret"`
	ControlSecret string            `json:"control_secret"`
	Env           map[string]string `json:"env"`
	Snapshot      Snapshot          `json:"snapshot"`
}

// Secrets returns the forward and control secrets.
func (r SpecResponse) Secrets() (forward, control string) {
	return r.ForwardSecret, r.ControlSecret
}

// Snapshot locates the source tar.gz of a deployment.
type Snapshot struct {
	ID  string `json:"id"`
	URL string `json:"url"`
}

// LogLine is one element of the POST /sv/v1/logs batch and of the local ring buffer.
// Deployment 0 means the line belongs to no deployment (supervisor boot,
// gateway lines); it is left out of the JSON, which the control plane stores
// as null rather than as a deployment numbered 0.
type LogLine struct {
	TS         time.Time `json:"ts"`
	Source     string    `json:"source"`
	Level      string    `json:"level"`
	Line       string    `json:"line"`
	Deployment int       `json:"deployment,omitempty"`
}

// Status is the body of POST /sv/v1/status.
type Status struct {
	Deployment int             `json:"deployment"`
	Phase      string          `json:"phase"`
	Step       string          `json:"step,omitempty"`
	Error      string          `json:"error,omitempty"`
	LogTail    []string        `json:"log_tail,omitempty"`
	Services   []ServiceStatus `json:"services"`
}

// ServiceStatus is one entry of the health/status `services` array. Pointer fields
// render as null when they do not apply (static services have no pid or port; a
// service that never exited has no exit code).
type ServiceStatus struct {
	Name         string `json:"name"`
	State        string `json:"state"`
	PID          *int   `json:"pid"`
	Restarts     int    `json:"restarts"`
	LastExitCode *int   `json:"last_exit_code"`
	Health       string `json:"health"`
	Port         *int   `json:"port"`
	// MemoryBytes is the resident memory of the service and its children.
	MemoryBytes *int64 `json:"memory_bytes"`
}

// HealthResponse is the body of GET /.boxlite/sv/health (contracts.md 2.3).
// Version is ProtocolVersion; Build is the binary's build string; Root and
// SudoLocked report the privilege split (contracts.md 2.1).
type HealthResponse struct {
	Version     int             `json:"version"`
	Build       string          `json:"build"`
	Root        bool            `json:"root"`
	SudoLocked  bool            `json:"sudo_locked"`
	OK          bool            `json:"ok"`
	Deployment  int             `json:"deployment"`
	SpecVersion int             `json:"spec_version"`
	Services    []ServiceStatus `json:"services"`
	// Box is the memory and disk of the whole Box; null where unreadable.
	Box *Box `json:"box"`
}

// Box is the memory and disk of the whole Box. The disk is the one holding
// the releases; volumes are directories on it too.
type Box struct {
	MemoryTotalBytes     int64 `json:"memory_total_bytes"`
	MemoryAvailableBytes int64 `json:"memory_available_bytes"`
	DiskTotalBytes       int64 `json:"disk_total_bytes"`
	DiskFreeBytes        int64 `json:"disk_free_bytes"`
}
