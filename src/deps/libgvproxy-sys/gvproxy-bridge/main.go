package main

/*
#include <stdlib.h>

typedef void (*log_callback_fn)(int level, const char* message);

static void call_rust_log_callback(void* callback, int level, const char* msg) {
	if (callback != NULL) {
		((log_callback_fn)callback)(level, msg);
	}
}
*/
import "C"
import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"runtime"
	"runtime/debug"
	"sync"
	"time"
	"unsafe"

	"github.com/containers/gvisor-tap-vsock/pkg/transport"
	"github.com/containers/gvisor-tap-vsock/pkg/types"
	"github.com/containers/gvisor-tap-vsock/pkg/virtualnetwork"
	logrus "github.com/sirupsen/logrus"
)

// Log level constants (match Rust tracing)
const (
	LogLevelTrace = 0
	LogLevelDebug = 1
	LogLevelInfo  = 2
	LogLevelWarn  = 3
	LogLevelError = 4
)

// RustTracingLogrusHook forwards logrus logs directly to Rust tracing
type RustTracingLogrusHook struct{}

func (h *RustTracingLogrusHook) Levels() []logrus.Level {
	return logrus.AllLevels
}

func (h *RustTracingLogrusHook) Fire(entry *logrus.Entry) error {
	callbackMu.RLock()
	callback := rustLogCallback
	callbackMu.RUnlock()

	if callback == nil {
		return nil // No callback registered, skip
	}

	// Build message with fields
	buf := make([]byte, 0, 256)
	buf = append(buf, entry.Message...)

	// Add logrus fields as key=value pairs
	for k, v := range entry.Data {
		buf = append(buf, ' ')
		buf = append(buf, k...)
		buf = append(buf, '=')
		buf = append(buf, fmt.Sprint(v)...)
	}

	// Map logrus level to Rust level
	var rustLevel int
	switch entry.Level {
	case logrus.TraceLevel:
		rustLevel = LogLevelTrace
	case logrus.DebugLevel:
		rustLevel = LogLevelDebug
	case logrus.InfoLevel:
		rustLevel = LogLevelInfo
	case logrus.WarnLevel:
		rustLevel = LogLevelWarn
	case logrus.ErrorLevel, logrus.FatalLevel, logrus.PanicLevel:
		rustLevel = LogLevelError
	default:
		rustLevel = LogLevelInfo
	}

	// Call Rust callback
	cMsg := C.CString(string(buf))
	C.call_rust_log_callback(callback, C.int(rustLevel), cMsg)
	C.free(unsafe.Pointer(cMsg))

	return nil
}

// RustTracingWriter redirects standard log package output to Rust tracing
type RustTracingWriter struct{}

func (w *RustTracingWriter) Write(p []byte) (n int, err error) {
	callbackMu.RLock()
	callback := rustLogCallback
	callbackMu.RUnlock()

	if callback == nil {
		return len(p), nil // No callback registered, discard
	}

	// Standard log package messages are typically info level
	// Remove trailing newline if present
	msg := string(p)
	if len(msg) > 0 && msg[len(msg)-1] == '\n' {
		msg = msg[:len(msg)-1]
	}

	// Call Rust callback with info level
	cMsg := C.CString(msg)
	C.call_rust_log_callback(callback, C.int(LogLevelInfo), cMsg)
	C.free(unsafe.Pointer(cMsg))

	return len(p), nil
}

// Global callback management
var (
	rustLogCallback unsafe.Pointer
	callbackMu      sync.RWMutex
)

//export gvproxy_set_log_callback
func gvproxy_set_log_callback(callback unsafe.Pointer) {
	callbackMu.Lock()
	rustLogCallback = callback
	callbackMu.Unlock()

	if callback != nil {
		// Forward all logrus logs to Rust tracing
		logrus.SetLevel(logrus.TraceLevel) // Enable trace level to support RUST_LOG=gvproxy=trace
		logrus.SetFormatter(&logrus.TextFormatter{
			DisableTimestamp: true, // Rust tracing adds its own timestamp
			DisableColors:    true,
		})
		logrus.SetOutput(io.Discard) // Discard direct output, only use hook to forward to Rust
		logrus.AddHook(&RustTracingLogrusHook{})

		// Redirect standard log package to Rust tracing (for vendored code like tcpproxy)
		log.SetOutput(&RustTracingWriter{})
		log.SetFlags(0) // Rust tracing adds its own timestamp and prefix
	} else {
		// Reset logrus to default
		logrus.SetLevel(logrus.InfoLevel)
		logrus.SetFormatter(&logrus.TextFormatter{})
		logrus.SetOutput(os.Stderr)

		// Reset standard log package
		log.SetOutput(os.Stderr)
		log.SetFlags(log.LstdFlags)
	}
}

// PortMapping represents a single port forward configuration
type PortMapping struct {
	HostPort  uint16 `json:"host_port"`
	GuestPort uint16 `json:"guest_port"`
}

// DNSRecord represents an exact A record within a local DNS zone.
type DNSRecord struct {
	Name string `json:"name"`
	IP   string `json:"ip"`
}

// DNSZone represents a local DNS zone configuration
// These are local DNS records served by the gateway's embedded DNS server.
// Queries not matching any zone are forwarded to the host's system DNS.
type DNSZone struct {
	Name      string      `json:"name"`              // Zone name (e.g., "myapp.local.", "." for root)
	Records   []DNSRecord `json:"records,omitempty"` // Exact A records within the zone
	DefaultIP string      `json:"default_ip"`        // Default IP for unmatched queries in this zone
}

// GvproxyConfig matches the Rust structure (must stay in sync!)
type GvproxyConfig struct {
	SocketPath       string         `json:"socket_path"`
	Subnet           string         `json:"subnet"`
	GatewayIP        string         `json:"gateway_ip"`
	GatewayMac       string         `json:"gateway_mac"`
	GuestIP          string         `json:"guest_ip"`
	HostIP           string         `json:"host_ip"`
	GuestMac         string         `json:"guest_mac"`
	MTU              uint16         `json:"mtu"`
	PortMappings     []PortMapping  `json:"port_mappings"`
	DNSZones         []DNSZone      `json:"dns_zones"`
	DNSSearchDomains []string       `json:"dns_search_domains"`
	Debug            bool           `json:"debug"`
	CaptureFile      *string        `json:"capture_file,omitempty"`
	AllowNet         []string       `json:"allow_net,omitempty"`
	Secrets          []SecretConfig `json:"secrets,omitempty"`
	CACertPEM        string         `json:"ca_cert_pem,omitempty"`
	CAKeyPEM         string         `json:"ca_key_pem,omitempty"`
}

// GvproxyInstance tracks a running gvisor-tap-vsock instance
type GvproxyInstance struct {
	ID            int64
	SocketPath    string
	Config        *types.Configuration
	Cancel        context.CancelFunc
	conn          net.Conn                       // For macOS UnixDgram (VFKit)
	listener      net.Listener                   // For Linux UnixStream (Qemu)
	vn            *virtualnetwork.VirtualNetwork // Virtual network for stats collection
	vnMu          sync.RWMutex                   // Protects vn field
	ca            *BoxCA                         // Ephemeral MITM CA (nil if no secrets)
	secretMatcher *SecretHostMatcher             // Hostname→secrets lookup (nil if no secrets)
	errSink       *ErrSink                       // Unified error propagation for background goroutines
}

func buildDNSZones(config GvproxyConfig) []types.Zone {
	dnsZones := make([]types.Zone, 0, len(config.DNSZones)+1)
	for _, zone := range config.DNSZones {
		dnsZone := types.Zone{
			Name:      zone.Name,
			DefaultIP: net.ParseIP(zone.DefaultIP),
		}
		for _, record := range zone.Records {
			dnsZone.Records = append(dnsZone.Records, types.Record{
				Name: record.Name,
				IP:   net.ParseIP(record.IP),
			})
		}
		dnsZones = append(dnsZones, dnsZone)
	}

	if len(config.AllowNet) > 0 {
		allowNetZones := buildAllowNetDNSZones(config.AllowNet)
		dnsZones = append(dnsZones, allowNetZones...)
		logrus.WithField("rules", len(config.AllowNet)).Info("Network allowlist enabled (DNS sinkhole)")
	}

	return dnsZones
}

func buildTapConfig(config GvproxyConfig, protocol types.Protocol) *types.Configuration {
	nat := make(map[string]string)
	gatewayVirtualIPs := []string{config.GatewayIP}
	if config.HostIP != "" {
		nat[config.HostIP] = "127.0.0.1"
		if config.HostIP != config.GatewayIP {
			gatewayVirtualIPs = append(gatewayVirtualIPs, config.HostIP)
		}
	}

	return &types.Configuration{
		Debug:             config.Debug,
		MTU:               int(config.MTU),
		Subnet:            config.Subnet,
		GatewayIP:         config.GatewayIP,
		GatewayMacAddress: config.GatewayMac,
		DHCPStaticLeases: map[string]string{
			config.GuestIP: config.GuestMac,
		},
		Forwards:          make(map[string]string),
		NAT:               nat,
		GatewayVirtualIPs: gatewayVirtualIPs,
		Protocol:          protocol,
		DNS:               buildDNSZones(config),
		DNSSearchDomains:  config.DNSSearchDomains,
		CaptureFile:       "",
	}
}

var (
	instances   = make(map[int64]*GvproxyInstance)
	instancesMu sync.RWMutex
	nextID      int64 = 1
)

// On failure (return -1), the underlying error message is written to `*errOut`
// as a heap-allocated C string. Caller must free it via gvproxy_free_string.
// `errOut` may be nil if the caller doesn't want the message.
//
//export gvproxy_create
func gvproxy_create(configJSON *C.char, errOut **C.char) C.longlong {
	// setErr surfaces the underlying error back to the FFI caller so the
	// Rust runtime can include it in the user-visible BoxliteError message
	// (e.g. "listen tcp 0.0.0.0:27380: bind: address already in use" instead
	// of an opaque "gvproxy_create failed").
	setErr := func(err error) {
		if errOut != nil {
			*errOut = C.CString(err.Error())
		}
	}

	goJSON := C.GoString(configJSON)

	var config GvproxyConfig
	if err := json.Unmarshal([]byte(goJSON), &config); err != nil {
		logrus.WithError(err).Error("Failed to parse gvproxy config")
		setErr(err)
		return -1
	}

	instancesMu.Lock()
	id := nextID
	nextID++
	instancesMu.Unlock()

	// Use caller-provided socket path (unique per box)
	socketPath := config.SocketPath
	if socketPath == "" {
		logrus.Error("socket_path is required in GvproxyConfig")
		setErr(fmt.Errorf("socket_path is required in GvproxyConfig"))
		return -1
	}

	// Remove stale socket from a previous crash (safe: path is unique per box)
	if err := os.Remove(socketPath); err != nil && !os.IsNotExist(err) {
		logrus.WithFields(logrus.Fields{"error": err, "path": socketPath}).Warn("Failed to remove existing socket")
	}

	// Platform-specific protocol selection
	var protocol types.Protocol
	if runtime.GOOS == "darwin" {
		protocol = types.VfkitProtocol
	} else {
		protocol = types.QemuProtocol
	}

	// Create gvisor-tap-vsock configuration from provided config
	tapConfig := buildTapConfig(config, protocol)

	// Set CaptureFile if provided
	if config.CaptureFile != nil && *config.CaptureFile != "" {
		tapConfig.CaptureFile = *config.CaptureFile
		logrus.WithField("capture_file", *config.CaptureFile).Info("Packet capture enabled")
	}

	// Add port forwards from config
	// Format: "0.0.0.0:PORT" for TCP (default), or "udp:0.0.0.0:PORT" for UDP
	// Do NOT use "tcp://" prefix - it causes "too many colons in address" error
	// Forward to guest's DHCP IP, not localhost
	// Containers bind to 0.0.0.0 inside the guest, accessible via guest IP
	for _, pm := range config.PortMappings {
		forwardKey := fmt.Sprintf("0.0.0.0:%d", pm.HostPort)
		forwardVal := fmt.Sprintf("%s:%d", config.GuestIP, pm.GuestPort)
		tapConfig.Forwards[forwardKey] = forwardVal
		logrus.WithFields(logrus.Fields{"host": forwardKey, "guest": forwardVal}).Info("Added TCP port forward")
	}

	// Platform-specific socket creation
	var conn net.Conn
	var listener net.Listener
	var err error

	if runtime.GOOS == "darwin" {
		// macOS: Use UnixDgram with VFKit protocol (SOCK_DGRAM)
		socketURI := fmt.Sprintf("unixgram://%s", socketPath)
		conn, err = transport.ListenUnixgram(socketURI)
		if err != nil {
			logrus.WithFields(logrus.Fields{"error": err, "path": socketPath}).Error("Failed to create Unix datagram socket")
			setErr(fmt.Errorf("failed to create Unix datagram socket %q: %w", socketPath, err))
			return -1
		}
		logrus.WithField("path", socketPath).Info("Created UnixDgram socket for VFKit protocol")
	} else {
		// Linux: Use UnixStream with Qemu protocol (SOCK_STREAM)
		listener, err = net.Listen("unix", socketPath)
		if err != nil {
			logrus.WithFields(logrus.Fields{"error": err, "path": socketPath}).Error("Failed to create Unix stream socket")
			setErr(fmt.Errorf("failed to create Unix stream socket %q: %w", socketPath, err))
			return -1
		}
		logrus.WithField("path", socketPath).Info("Created UnixStream socket for Qemu protocol")
	}

	// Start gvisor-tap-vsock in background
	ctx, cancel := context.WithCancel(context.Background())

	instance := &GvproxyInstance{
		ID:         id,
		SocketPath: socketPath,
		Config:     tapConfig,
		Cancel:     cancel,
		conn:       conn,
		listener:   listener,
		errSink:    NewErrSink(id),
	}

	// Parse MITM CA from config (generated by Rust) when secrets are configured
	if config.CACertPEM != "" && config.CAKeyPEM != "" {
		ca, err := NewBoxCAFromPEM([]byte(config.CACertPEM), []byte(config.CAKeyPEM))
		if err != nil {
			logrus.WithError(err).Error("MITM: failed to parse CA from config")
			setErr(fmt.Errorf("MITM: failed to parse CA from config: %w", err))
			cancel()
			return -1
		}
		// Wire the ErrSink into the CA so MITM cert-generation failures
		// surface to the Rust polling consumer (security-shaped: a
		// persistent cert-gen failure means MITM is silently disabled
		// for that hostname). Per-conn TLS handshake / upstream dial
		// errors stay log-only — those are expected failure modes, not
		// silent regressions worth surfacing.
		ca.SetErrSink(instance.errSink)
		instance.ca = ca
		instance.secretMatcher = NewSecretHostMatcher(config.Secrets)
		logrus.WithField("num_secrets", len(config.Secrets)).Info("MITM: loaded CA from Rust config")
	}

	instancesMu.Lock()
	instances[id] = instance
	instancesMu.Unlock()

	// init-phase errors are surfaced via instance.errSink.WaitInit() below.
	// The sink unifies what used to be an ad-hoc `initErr` channel plus four
	// per-site `logrus.Error` swallows (OverrideTCPHandler / Accept[Vfkit|Qemu]
	// / vn.Accept[Vfkit|Qemu]) into one entry point. See error_sink.go.
	sink := instance.errSink

	// Start runtime metrics monitoring goroutine
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				var memStats runtime.MemStats
				runtime.ReadMemStats(&memStats)

				logrus.WithFields(logrus.Fields{
					"id":            id,
					"goroutines":    runtime.NumGoroutine(),
					"os_threads":    runtime.GOMAXPROCS(0),
					"cgo_calls":     runtime.NumCgoCall(),
					"heap_alloc_mb": memStats.Alloc / 1024 / 1024,
					"sys_mb":        memStats.Sys / 1024 / 1024,
					"num_gc":        memStats.NumGC,
				}).Info("gvproxy runtime metrics")
			}
		}
	}()

	// Start virtual network in goroutine.
	//
	// init phase = (virtualnetwork.New) + (OverrideTCPHandler). The latter
	// moved from post-init to init: a TCP-handler-override failure means
	// allow_net / MITM is silently bypassed, which is a security gap an
	// operator MUST see at `box.create` time, not 20s later when a guest
	// gets through to a blocked host.
	go func() {
		vn, err := virtualnetwork.New(tapConfig)
		if err != nil {
			logrus.WithFields(logrus.Fields{"error": err, "id": id}).Error("Failed to create virtual network")
			sink.Init("virtualnetwork.New", err)
			return
		}

		// Override TCP handler with AllowNet filter and/or MITM secret substitution.
		// FAILURE PROPAGATION: silent before — if this returned an error, allow_net
		// did NOT actually filter and MITM did NOT actually substitute, but
		// gvproxy_create returned success and the box looked healthy. Now: surfaced
		// via sink.Init so box.create aborts.
		//
		// Extracted into installTCPOverride for test-time failure injection. See
		// install_tcp_override_test.go for the two-sided wiring proof.
		installTCPHandler := func() error {
			return OverrideTCPHandler(vn, tapConfig, tapConfig.Ec2MetadataAccess,
				newTCPFilterFromConfig(config), instance.ca, instance.secretMatcher)
		}
		hasTCPFilter := len(config.AllowNet) > 0 || instance.secretMatcher != nil
		if err := installTCPOverride(hasTCPFilter, installTCPHandler); err != nil {
			logrus.WithError(err).Error("TCP: failed to override handler")
			sink.Init("OverrideTCPHandler", err)
			return
		}

		// All init-phase work done — release the cgo caller.
		sink.Init("", nil)

		// Store VirtualNetwork reference for stats collection
		instance.vnMu.Lock()
		instance.vn = vn
		instance.vnMu.Unlock()

		// Platform-specific packet handling — runtime phase from here down.
		// Accept[Vfkit|Qemu] blocks on the VM connecting; vn.Accept[Vfkit|Qemu]
		// runs the protocol for the lifetime of that VM. Pre-fix both fell into
		// `logrus.Error + return`; post-fix they push to sink.Runtime so the Rust
		// runtime sees a structured `Network` error in the box log.
		if runtime.GOOS == "darwin" {
			// macOS: Handle VFKit datagram packets
			// VFKit requires a two-step process:
			// 1. transport.AcceptVfkit() - Waits for incoming data and wraps listener with remote address
			// 2. vn.AcceptVfkit() - Handles the VFKit protocol
			//
			// Extracted into runVfkitAcceptLoop so tests can drive it with mock
			// transport + protocol functions. See vfkit_accept_loop_test.go.
			go runVfkitAcceptLoop(ctx, id, conn.(*net.UnixConn), transport.AcceptVfkit, vn.AcceptVfkit, sink)
		} else {
			// Linux: Handle Qemu stream connections.
			// Extracted into runQemuAcceptLoop so tests can drive the same
			// goroutine body against a real Unix socket + cancellable ctx and
			// observe the sink reactions, instead of having to spin up the
			// full gvproxy_create cgo path. The test exercise in
			// `qemu_accept_loop_test.go` closes the listener mid-Accept and
			// asserts the listener.Accept error reaches the sink.
			go runQemuAcceptLoop(ctx, id, listener, vn.AcceptQemu, sink)
		}

		// Wait for context cancellation
		<-ctx.Done()

		// Cleanup
		if runtime.GOOS == "darwin" && conn != nil {
			conn.Close()
		} else if listener != nil {
			listener.Close()
		}
		os.Remove(socketPath)
	}()

	// Wait for the init phase (virtualnetwork.New + OverrideTCPHandler) to
	// complete before returning a valid id. On failure, tear down the instance
	// and surface -1 so the FFI caller (Rust boxlite runtime) can fail fast
	// with a clear error instead of shipping a broken socket downstream.
	if err := sink.WaitInit(); err != nil {
		logrus.WithFields(logrus.Fields{"error": err, "id": id}).Error("gvproxy init failed; tearing down instance")
		setErr(err)
		cancel()
		instancesMu.Lock()
		delete(instances, id)
		instancesMu.Unlock()
		if runtime.GOOS == "darwin" && conn != nil {
			conn.Close()
		} else if listener != nil {
			listener.Close()
		}
		os.Remove(socketPath)
		return -1
	}

	logrus.Info("Created gvproxy instance", "id", id, "socket", socketPath, "protocol", protocol)
	return C.longlong(id)
}

//export gvproxy_free_string
func gvproxy_free_string(str *C.char) {
	C.free(unsafe.Pointer(str))
}

//export gvproxy_destroy
func gvproxy_destroy(id C.longlong) C.int {
	instancesMu.Lock()
	instance, ok := instances[int64(id)]
	if ok {
		delete(instances, int64(id))
	}
	instancesMu.Unlock()

	if !ok {
		return -1
	}

	// Cancel context to stop goroutines
	instance.Cancel()

	logrus.Info("Destroyed gvproxy instance", "id", id)
	return 0
}

// gvproxy_poll_runtime_error returns the oldest unread post-init error
// for the given instance, or nil if the queue is empty.
//
// The returned string is heap-allocated and the caller (Rust runtime)
// MUST free it with `gvproxy_free_string`. Format:
//
//	[2026-06-03T12:34:56.789Z] vn.AcceptQemu: connection reset by peer
//
// Intended to be called from a background tokio task that polls every
// ~250ms — each non-nil return is logged into the box's log file as a
// structured Network error so the operator sees runtime failures (Accept
// failures, protocol handler errors, TCP filter post-init misconfig) at
// human timescale instead of having to grep gvproxy logs.
//
// Pre-this-change: the five sites that now feed sink.Runtime() only ran
// `logrus.Error` — invisible to anyone outside the gvproxy debug log.
//
//export gvproxy_poll_runtime_error
func gvproxy_poll_runtime_error(id C.longlong) *C.char {
	instancesMu.RLock()
	instance, ok := instances[int64(id)]
	instancesMu.RUnlock()
	if !ok || instance.errSink == nil {
		return nil
	}
	re := instance.errSink.PollRuntime()
	if re == nil {
		return nil
	}
	return C.CString(re.String())
}

// gvproxy_test_create_for_polling builds a minimal GvproxyInstance that
// has an ErrSink but NO socket, NO goroutines, NO virtual network. Used
// exclusively by Rust integration tests that want to validate the
// `gvproxy_poll_runtime_error` polling pattern without paying the cost
// of standing up a real VM transport.
//
// Pairs with `gvproxy_test_inject_runtime_error` for the inject side.
//
// The returned id is real — `gvproxy_destroy` cleans it up the same as
// a real instance (the Cancel func is set but does nothing meaningful
// because no goroutines were ever spawned).
//
//export gvproxy_test_create_for_polling
func gvproxy_test_create_for_polling() C.longlong {
	instancesMu.Lock()
	id := nextID
	nextID++
	ctx, cancel := context.WithCancel(context.Background())
	_ = ctx // not used; goroutines aren't spawned in this fixture
	instances[id] = &GvproxyInstance{
		ID:      id,
		Cancel:  cancel,
		errSink: NewErrSink(id),
	}
	instancesMu.Unlock()
	return C.longlong(id)
}

// gvproxy_test_inject_runtime_error pushes a synthetic runtime error
// into the named instance's ErrSink. Pairs with the test-only fixture
// above so Rust integration tests can drive the full poll path:
//
//	id := gvproxy_test_create_for_polling()
//	gvproxy_test_inject_runtime_error(id, "AcceptQemu", "use of closed network connection")
//	str := gvproxy_poll_runtime_error(id)  // -> "[ts] AcceptQemu: use of closed network connection"
//
// Both arg strings are caller-owned C strings (this fn copies them
// before returning, so the caller may free immediately).
//
//export gvproxy_test_inject_runtime_error
func gvproxy_test_inject_runtime_error(id C.longlong, source *C.char, message *C.char) {
	instancesMu.RLock()
	instance, ok := instances[int64(id)]
	instancesMu.RUnlock()
	if !ok || instance.errSink == nil {
		return
	}
	src := C.GoString(source)
	msg := C.GoString(message)
	instance.errSink.Runtime(src, errors.New(msg))
}

//export gvproxy_get_stats
func gvproxy_get_stats(id C.longlong) *C.char {
	// Validate Early: Check instance exists
	instancesMu.RLock()
	instance, ok := instances[int64(id)]
	instancesMu.RUnlock()

	if !ok {
		return nil
	}

	// Validate Early: Check vn initialized
	// (instance.vn might not be set yet if called too early)
	instance.vnMu.RLock()
	vn := instance.vn
	instance.vnMu.RUnlock()

	if vn == nil {
		return nil
	}

	// Single Responsibility: Delegate to stats.go for collection
	stats := collectNetworkStats(vn)
	if stats == "" {
		return nil
	}

	// Explicit: CString allocates memory, caller must free it
	return C.CString(stats)
}

//export gvproxy_get_version
func gvproxy_get_version() *C.char {
	// Get gvisor-tap-vsock version from build info
	buildInfo, ok := debug.ReadBuildInfo()
	if !ok {
		return C.CString("unknown")
	}

	// Find gvisor-tap-vsock dependency
	for _, dep := range buildInfo.Deps {
		if dep.Path == "github.com/containers/gvisor-tap-vsock" {
			return C.CString(dep.Version)
		}
	}

	return C.CString("unknown")
}

func main() {
	// CGO library, no main needed
}
