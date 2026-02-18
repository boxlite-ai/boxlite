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

// DNSZone represents a local DNS zone configuration
// These are local DNS records served by the gateway's embedded DNS server.
// Queries not matching any zone are forwarded to the host's system DNS.
type DNSZone struct {
	Name      string `json:"name"`       // Zone name (e.g., "myapp.local.", "." for root)
	DefaultIP string `json:"default_ip"` // Default IP for unmatched queries in this zone
}

// GvproxyConfig matches the Rust structure (must stay in sync!)
type GvproxyConfig struct {
	SocketPath       string        `json:"socket_path"`
	Subnet           string        `json:"subnet"`
	GatewayIP        string        `json:"gateway_ip"`
	GatewayMac       string        `json:"gateway_mac"`
	GuestIP          string        `json:"guest_ip"`
	GuestMac         string        `json:"guest_mac"`
	MTU              uint16        `json:"mtu"`
	PortMappings     []PortMapping `json:"port_mappings"`
	DNSZones         []DNSZone     `json:"dns_zones"`
	DNSSearchDomains []string      `json:"dns_search_domains"`
	Debug            bool          `json:"debug"`
	CaptureFile      *string       `json:"capture_file,omitempty"`
}

// GvproxyInstance tracks a running gvisor-tap-vsock instance
type GvproxyInstance struct {
	ID         int64
	SocketPath string
	Config     *types.Configuration
	Cancel     context.CancelFunc
	conn       net.Conn                       // For macOS UnixDgram (VFKit)
	listener   net.Listener                   // For Linux UnixStream (Qemu)
	vn         *virtualnetwork.VirtualNetwork // Virtual network for stats collection
	vnMu       sync.RWMutex                   // Protects vn field
}

var (
	instances   = make(map[int64]*GvproxyInstance)
	instancesMu sync.RWMutex
	nextID      int64 = 1
)

//export gvproxy_create
func gvproxy_create(configJSON *C.char) C.longlong {
	goJSON := C.GoString(configJSON)

	var config GvproxyConfig
	if err := json.Unmarshal([]byte(goJSON), &config); err != nil {
		logrus.WithError(err).Error("Failed to parse gvproxy config")
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

	// Build DNS zones from config
	// These are local DNS records - queries not matching any zone are forwarded to host DNS
	dnsZones := make([]types.Zone, len(config.DNSZones))
	for i, zone := range config.DNSZones {
		dnsZones[i] = types.Zone{
			Name:      zone.Name,
			DefaultIP: net.ParseIP(zone.DefaultIP),
		}
	}

	// Create gvisor-tap-vsock configuration from provided config
	tapConfig := &types.Configuration{
		Debug:             config.Debug,
		MTU:               int(config.MTU),
		Subnet:            config.Subnet,
		GatewayIP:         config.GatewayIP,
		GatewayMacAddress: config.GatewayMac,
		DHCPStaticLeases: map[string]string{
			config.GuestIP: config.GuestMac,
		},
		Forwards: make(map[string]string),
		NAT: map[string]string{
			config.GuestIP: "127.0.0.1",
		},
		GatewayVirtualIPs: []string{config.GatewayIP},
		Protocol:          protocol,
		DNS:               dnsZones,
		DNSSearchDomains:  config.DNSSearchDomains,
	}

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
			return -1
		}
		logrus.WithField("path", socketPath).Info("Created UnixDgram socket for VFKit protocol")
	} else {
		// Linux: Use UnixStream with Qemu protocol (SOCK_STREAM)
		listener, err = net.Listen("unix", socketPath)
		if err != nil {
			logrus.WithFields(logrus.Fields{"error": err, "path": socketPath}).Error("Failed to create Unix stream socket")
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
	}

	instancesMu.Lock()
	instances[id] = instance
	instancesMu.Unlock()

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

	// Start virtual network in goroutine
	go func() {
		vn, err := virtualnetwork.New(tapConfig)
		if err != nil {
			logrus.WithFields(logrus.Fields{"error": err, "id": id}).Error("Failed to create virtual network")
			return
		}

		// Store VirtualNetwork reference for stats collection
		instance.vnMu.Lock()
		instance.vn = vn
		instance.vnMu.Unlock()

		// Platform-specific packet handling
		if runtime.GOOS == "darwin" {
			// macOS: Handle VFKit datagram packets
			// VFKit requires a two-step process:
			// 1. transport.AcceptVfkit() - Waits for incoming data and wraps listener with remote address
			// 2. vn.AcceptVfkit() - Handles the VFKit protocol
			go func() {
				logrus.WithField("id", id).Trace("Waiting for VFKit connection on UnixDgram socket")

				// Wait for incoming connection and get wrapped connection with remote address
				// AcceptVfkit peeks at the first packet to get the remote address
				wrappedConn, err := transport.AcceptVfkit(conn.(*net.UnixConn))
				if err != nil {
					logrus.WithFields(logrus.Fields{"error": err, "id": id}).Error("Failed to accept VFKit connection")
					return
				}

				logrus.WithFields(logrus.Fields{"id": id, "remote": wrappedConn.RemoteAddr().String()}).Info("VFKit connection accepted")

				// Handle the VFKit protocol with the wrapped connection
				if err := vn.AcceptVfkit(ctx, wrappedConn); err != nil {
					if ctx.Err() == nil {
						logrus.WithFields(logrus.Fields{"error": err, "id": id}).Error("AcceptVfkit error")
					}
				}
			}()
		} else {
			// Linux: Handle Qemu stream connections
			go func() {
				logrus.WithField("id", id).Trace("Waiting for Qemu connection on UnixStream socket")

				// Accept incoming connection (blocks until VM connects)
				acceptedConn, err := listener.Accept()
				if err != nil {
					if ctx.Err() == nil {
						logrus.WithFields(logrus.Fields{"error": err, "id": id}).Error("Failed to accept connection")
					}
					return
				}

				logrus.WithFields(logrus.Fields{"id": id, "remote": acceptedConn.RemoteAddr().String()}).Info("Qemu connection accepted")

				// Close listener after first connection (one VM per gvproxy instance)
				listener.Close()

				// Handle the Qemu protocol
				if err := vn.AcceptQemu(ctx, acceptedConn); err != nil {
					if ctx.Err() == nil {
						logrus.WithFields(logrus.Fields{"error": err, "id": id}).Error("AcceptQemu error")
					}
				}
			}()
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
