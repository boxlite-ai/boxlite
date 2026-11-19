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
	"net/http"
	"os"
	"runtime"
	"runtime/debug"
	"strings"
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

// DNSRecord represents an exact A record within a local DNS zone.
type DNSRecord struct {
	Name string `json:"name"`
	IP   string `json:"ip"`
}

// DNSZone represents a local DNS zone configuration
// These are local DNS records served by the gateway's embedded DNS server.
// Queries outside the local zones use the active route's resolver.
type DNSZone struct {
	Name      string      `json:"name"`              // Zone name (e.g., "myapp.local.", "." for root)
	Records   []DNSRecord `json:"records,omitempty"` // Exact A records within the zone
	DefaultIP string      `json:"default_ip"`        // Default IP for unmatched queries in this zone
}

// GvproxyConfig is the bridge startup wire object. Network settings mirror
// Rust's GvproxyConfig; OutboundRevision is optional control-plane metadata.
type GvproxyConfig struct {
	SocketPath       string         `json:"socket_path"`
	Subnet           string         `json:"subnet"`
	GatewayIP        string         `json:"gateway_ip"`
	GatewayMac       string         `json:"gateway_mac"`
	GuestIP          string         `json:"guest_ip"`
	HostIP           string         `json:"host_ip"`
	GuestMac         string         `json:"guest_mac"`
	MTU              uint16         `json:"mtu"`
	DNSZones         []DNSZone      `json:"dns_zones"`
	DNSSearchDomains []string       `json:"dns_search_domains"`
	Debug            bool           `json:"debug"`
	CaptureFile      *string        `json:"capture_file,omitempty"`
	AllowNet         []string       `json:"allow_net,omitempty"`
	OutboundDisabled bool           `json:"outbound_disabled,omitempty"`
	OutboundRevision string         `json:"outbound_revision,omitempty"`
	Secrets          []SecretConfig `json:"secrets,omitempty"`
	CACertPEM        string         `json:"ca_cert_pem,omitempty"`
	CAKeyPEM         string         `json:"ca_key_pem,omitempty"`
	// ControlSocketPath, when set, binds gvproxy's ServicesMux (dynamic port
	// forwarding / DNS / DHCP leases / stats / cam) to a host unix socket the
	// boxlite core dials. Empty => the services API is not exposed.
	ControlSocketPath string `json:"control_socket_path,omitempty"`

	// RateLimit, when set, shapes the guest link in both directions. Absent or
	// zero-sized in a direction means that direction is unlimited. See shaper.go.
	RateLimit *RateLimitConfig `json:"rate_limit,omitempty"`
}

// GvproxyInstance tracks a running gvisor-tap-vsock instance
type GvproxyInstance struct {
	ID            int64
	SocketPath    string
	Config        *types.Configuration
	Cancel        context.CancelFunc
	managedDone   <-chan struct{}                // Closed when managed shutdown has joined its work
	conn          net.Conn                       // For macOS UnixDgram (VFKit)
	listener      net.Listener                   // For Linux UnixStream (Qemu)
	vn            *virtualnetwork.VirtualNetwork // Virtual network for stats collection
	vnMu          sync.RWMutex                   // Protects vn field
	ca            *BoxCA                         // Per-box MITM CA (nil if no secrets)
	secretMatcher *SecretHostMatcher             // Hostname→secrets lookup (nil if no secrets)
}

// buildDNSZones converts the zones the caller configures (the
// host.boxlite.internal alias) into upstream's zone type, and that is all the
// box's DNS server serves beyond forwarding. allow_net does not touch DNS: it
// is enforced when the gateway dials (forked_tcp.go, egress_dialer.go), so a
// name outside the allowlist resolves like any other and is refused at
// connect. An earlier design sinkholed unlisted names here, which only ever
// covered A queries and so never closed the channel it appeared to.
func buildDNSZones(config GvproxyConfig) []types.Zone {
	dnsZones := make([]types.Zone, 0, len(config.DNSZones))
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
	return dnsZones
}

// newAllowNetFilter builds the egress allowlist for a box. It is the single
// place that decides which addresses are exempt from allow_net, so the test
// harness can build its filter the same way and a change here cannot pass
// unnoticed.
//
// The gateway and guest addresses are the virtual network's own endpoints
// rather than egress destinations. config.HostIP is deliberately not among
// them: it NATs to the host's loopback (buildTapConfig below), which makes it
// a real destination that must obey allow_net like any other. Its DNS record
// is still served unconditionally — resolving the alias is not egress.
//
// Returns nil when allow_net is empty, which the transport handlers read as
// "forward everything".
func newAllowNetFilter(config GvproxyConfig) *AllowNetFilter {
	return NewAllowNetFilter(config.AllowNet, config.GatewayIP, config.GuestIP)
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
	return createGvproxyFFI(configJSON, nil, errOut)
}

type managedNetworkStartup struct {
	route *managedRouteConfig
}

//export gvproxy_create_managed
func gvproxy_create_managed(configJSON, routeJSON *C.char, errOut **C.char) C.longlong {
	managed := &managedNetworkStartup{}
	if routeJSON != nil {
		decoder := json.NewDecoder(strings.NewReader(C.GoString(routeJSON)))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&managed.route) != nil || decoder.Decode(new(any)) != io.EOF {
			if errOut != nil {
				*errOut = C.CString("invalid managed proxy startup route")
			}
			return -1
		}
	}
	return createGvproxyFFI(configJSON, managed, errOut)
}

func createGvproxyFFI(configJSON *C.char, managed *managedNetworkStartup, errOut **C.char) C.longlong {
	var config GvproxyConfig
	err := json.Unmarshal([]byte(C.GoString(configJSON)), &config)
	var id int64
	if err == nil {
		id, err = startGvproxy(config, managed)
	}
	if err != nil {
		if errOut != nil {
			*errOut = C.CString(err.Error())
		}
		return -1
	}
	return C.longlong(id)
}

func startGvproxy(config GvproxyConfig, managed *managedNetworkStartup) (int64, error) {
	protocol := types.QemuProtocol
	if runtime.GOOS == "darwin" {
		protocol = types.VfkitProtocol
	}
	return startGvproxyOnTransport(config, managed, protocol, nil)
}

// prepareGuestSocket lets the socket lifecycle tests hold a real writer at
// the final handoff while exercising the same owner on both host platforms.
func startGvproxyOnTransport(config GvproxyConfig, managed *managedNetworkStartup, protocol types.Protocol, prepareGuestSocket func(net.Conn) net.Conn) (int64, error) {
	// Reject a bad rate limit outright rather than letting part of it apply.
	if err := config.RateLimit.Validate(); err != nil {
		logrus.WithError(err).Error("Invalid gvproxy rate limit config")
		return -1, err
	}

	instancesMu.Lock()
	id := nextID
	nextID++
	instancesMu.Unlock()

	// Use caller-provided socket path (unique per box)
	socketPath := config.SocketPath
	if socketPath == "" {
		return -1, fmt.Errorf("socket_path is required in GvproxyConfig")
	}

	// Remove stale socket from a previous crash (safe: path is unique per box)
	if err := os.Remove(socketPath); err != nil && !os.IsNotExist(err) {
		logrus.WithFields(logrus.Fields{"error": err, "path": socketPath}).Warn("Failed to remove existing socket")
	}

	// Create gvisor-tap-vsock configuration from provided config
	tapConfig := buildTapConfig(config, protocol)

	// Set CaptureFile if provided
	if config.CaptureFile != nil && *config.CaptureFile != "" {
		tapConfig.CaptureFile = *config.CaptureFile
		logrus.WithField("capture_file", *config.CaptureFile).Info("Packet capture enabled")
	}

	// Platform-specific socket creation
	var conn net.Conn
	var listener net.Listener
	var err error

	if protocol == types.VfkitProtocol {
		// macOS: Use UnixDgram with VFKit protocol (SOCK_DGRAM)
		socketURI := fmt.Sprintf("unixgram://%s", socketPath)
		conn, err = transport.ListenUnixgram(socketURI)
		if err != nil {
			logrus.WithFields(logrus.Fields{"error": err, "path": socketPath}).Error("Failed to create Unix datagram socket")
			return -1, fmt.Errorf("failed to create Unix datagram socket %q: %w", socketPath, err)
		}
		logrus.WithField("path", socketPath).Info("Created UnixDgram socket for VFKit protocol")
	} else {
		// Linux: Use UnixStream with Qemu protocol (SOCK_STREAM)
		listener, err = net.Listen("unix", socketPath)
		if err != nil {
			logrus.WithFields(logrus.Fields{"error": err, "path": socketPath}).Error("Failed to create Unix stream socket")
			return -1, fmt.Errorf("failed to create Unix stream socket %q: %w", socketPath, err)
		}
		logrus.WithField("path", socketPath).Info("Created UnixStream socket for Qemu protocol")
	}

	// Start gvisor-tap-vsock in background
	ctx, cancel := context.WithCancel(context.Background())
	closeGuestSocket := func() {
		if conn != nil {
			_ = conn.Close()
		} else if listener != nil {
			_ = listener.Close()
		}
		_ = os.Remove(socketPath)
	}
	wrapLink := func(raw net.Conn, prefix int) net.Conn {
		if prepareGuestSocket != nil {
			raw = prepareGuestSocket(raw)
		}
		return wrapGuestConn(raw, prefix, config.RateLimit, managed != nil)
	}

	instance := &GvproxyInstance{
		ID:         id,
		SocketPath: socketPath,
		Config:     tapConfig,
		Cancel:     cancel,
		conn:       conn,
		listener:   listener,
	}

	// Parse MITM CA from config (generated by Rust) when secrets are configured
	if config.CACertPEM != "" && config.CAKeyPEM != "" {
		ca, err := NewBoxCAFromPEM([]byte(config.CACertPEM), []byte(config.CAKeyPEM))
		if err != nil {
			logrus.WithError(err).Error("MITM: failed to parse CA from config")
			cancel()
			closeGuestSocket()
			return -1, fmt.Errorf("MITM: failed to parse CA from config: %w", err)
		}
		instance.ca = ca
		instance.secretMatcher = NewSecretHostMatcher(config.Secrets)
		logrus.WithField("num_secrets", len(config.Secrets)).Info("MITM: loaded CA from Rust config")
	}

	instancesMu.Lock()
	instances[id] = instance
	instancesMu.Unlock()

	// initErr keeps gvproxy_create synchronous until the virtual network and
	// optional ServicesMux control socket are ready, and surfaces startup
	// failures to the FFI caller.
	initErr := make(chan error, 1)
	stopped := make(chan struct{})
	if managed != nil {
		instance.managedDone = stopped
	}

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
		defer close(stopped)
		var vn *virtualnetwork.VirtualNetwork
		var policy *outboundPolicyController
		var gateway *gatewayDNS
		var controlListener net.Listener
		var controlServer *http.Server
		var guestDone chan struct{}
		defer func() {
			if gateway != nil {
				policy.stopManagedNetwork()
			}
			if controlListener != nil {
				// Interrupt partial bodies before joining admitted PUT handlers.
				_ = controlServer.Close()
				_ = controlListener.Close()
				_ = os.Remove(config.ControlSocketPath)
			}
			closeGuestSocket()
			if gateway != nil {
				if guestDone != nil {
					<-guestDone
				}
				policy.waitManagedNetwork(gateway)
			}
			if managed != nil && vn != nil {
				if networkStack, err := stackOf(vn); err == nil {
					networkStack.Close()
					networkStack.Wait()
				}
			}
		}()
		var work *dnsLookupWork
		var route *proxyDNSResolver
		if managed != nil {
			work = newDNSLookupWork(ctx)
			var routeErr error
			route, routeErr = managed.route.resolver(config.Subnet, work)
			if routeErr != nil {
				initErr <- routeErr
				return
			}
		}
		vn, err := virtualnetwork.New(tapConfig)
		if err != nil {
			logrus.WithFields(logrus.Fields{"error": err, "id": id}).Error("Failed to create virtual network")
			initErr <- err
			return
		}

		mode := "enabled"
		if config.OutboundDisabled {
			mode = "disabled"
		}
		policy, err = newOutboundPolicyController(vn, tapConfig, config.GuestIP, instance.ca, instance.secretMatcher, outboundPolicy{Mode: mode, AllowNet: config.AllowNet}, config.OutboundRevision)
		if err != nil {
			initErr <- fmt.Errorf("initialize outbound policy: %w", err)
			return
		}
		if managed != nil {
			gateway, err = policy.installManagedNetwork(ctx, work, route)
			if err != nil {
				initErr <- fmt.Errorf("initialize managed network: %w", err)
				return
			}
		}

		// Store VirtualNetwork reference for stats collection
		instance.vnMu.Lock()
		instance.vn = vn
		instance.vnMu.Unlock()

		// Bind gvproxy's ServicesMux (via controlMux, which replaces /tunnel) to
		// a host unix socket so the boxlite core can drive dynamic port
		// forwarding / DNS / leases on the running box.
		// ServicesMux (not Mux) excludes the raw L2 /connect, so the VM's NIC
		// can never be attached through this socket.
		if config.ControlSocketPath != "" {
			// Remove a stale socket from a previous crash (path is unique per box).
			if rmErr := os.Remove(config.ControlSocketPath); rmErr != nil && !os.IsNotExist(rmErr) {
				logrus.WithFields(logrus.Fields{"error": rmErr, "path": config.ControlSocketPath}).Warn("Failed to remove existing services socket")
			}
			l, lErr := net.Listen("unix", config.ControlSocketPath)
			if lErr != nil {
				logrus.WithFields(logrus.Fields{"error": lErr, "path": config.ControlSocketPath}).Error("Failed to bind gvproxy services socket")
				initErr <- fmt.Errorf("failed to bind gvproxy services socket %q: %w", config.ControlSocketPath, lErr)
				return
			} else {
				controlListener = l
				logrus.WithField("path", config.ControlSocketPath).Info("Serving gvproxy ServicesMux")
				mux := http.NewServeMux()
				mux.Handle("/", controlMux(vn.ServicesMux(), vn.DialContextTCP))
				mux.Handle("/network/outbound", policy)
				mux.Handle(outboundStatusPath, policy)
				mux.Handle(outboundSnapshotPath, policy)
				if gateway != nil {
					mux.Handle("/services/dns/all", gateway)
					mux.Handle("/services/dns/add", gateway)
				}
				controlServer = &http.Server{
					Handler:           mux,
					ReadHeaderTimeout: 5 * time.Second,
					BaseContext:       func(net.Listener) context.Context { return ctx },
				}
				go func() {
					if sErr := controlServer.Serve(l); sErr != nil && ctx.Err() == nil {
						logrus.WithError(sErr).Error("gvproxy services HTTP server exited")
					}
				}()
			}
		}
		initErr <- nil
		guestDone = make(chan struct{})

		// Platform-specific packet handling
		if protocol == types.VfkitProtocol {
			// macOS: Handle VFKit datagram packets
			// VFKit requires a two-step process:
			// 1. transport.AcceptVfkit() - Waits for incoming data and wraps listener with remote address
			// 2. vn.AcceptVfkit() - Handles the VFKit protocol
			go func() {
				defer close(guestDone)
				logrus.WithField("id", id).Trace("Waiting for VFKit connection on UnixDgram socket")

				// Wait for incoming connection and get wrapped connection with remote address
				// AcceptVfkit peeks at the first packet to get the remote address
				wrappedConn, err := transport.AcceptVfkit(conn.(*net.UnixConn))
				if err != nil {
					if ctx.Err() == nil {
						logrus.WithFields(logrus.Fields{"error": err, "id": id}).Error("Failed to accept VFKit connection")
					}
					return
				}

				logrus.WithFields(logrus.Fields{"id": id, "remote": wrappedConn.RemoteAddr().String()}).Info("VFKit connection accepted")

				// Handle the VFKit protocol with the wrapped connection
				if err := serveGuestLink(ctx, wrapLink(wrappedConn, 0), vn.AcceptVfkit); err != nil {
					if ctx.Err() == nil {
						logrus.WithFields(logrus.Fields{"error": err, "id": id}).Error("AcceptVfkit error")
					}
				}
			}()
		} else {
			// Linux: Handle Qemu stream connections
			go func() {
				defer close(guestDone)
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
				if err := serveGuestLink(ctx, wrapLink(acceptedConn, 4), vn.AcceptQemu); err != nil {
					if ctx.Err() == nil {
						logrus.WithFields(logrus.Fields{"error": err, "id": id}).Error("AcceptQemu error")
					}
				}
			}()
		}

		// Wait for context cancellation
		<-ctx.Done()

	}()

	// Wait for virtualnetwork.New to complete before returning a valid id.
	// On failure, tear down the instance and surface -1 so the FFI caller
	// (Rust boxlite runtime) can fail fast with a clear error instead of
	// shipping a broken socket downstream.
	if err := <-initErr; err != nil {
		logrus.WithFields(logrus.Fields{"error": err, "id": id}).Error("gvproxy init failed; tearing down instance")
		cancel()
		<-stopped
		instancesMu.Lock()
		delete(instances, id)
		instancesMu.Unlock()
		return -1, err
	}

	logrus.Info("Created gvproxy instance", "id", id, "socket", socketPath, "protocol", protocol)
	return id, nil
}

func wrapGuestConn(conn net.Conn, prefixLen int, config *RateLimitConfig, managed bool) net.Conn {
	if !managed {
		return wrapConn(conn, prefixLen, config)
	}
	// Managed replies still need the owner check on an unlimited link.
	if config == nil {
		config = &RateLimitConfig{}
	}
	return newShapedConn(conn, prefixLen, config, nil)
}

func serveGuestLink(ctx context.Context, conn net.Conn, accept func(context.Context, net.Conn) error) error {
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	defer conn.Close()
	return accept(ctx, conn)
}

//export gvproxy_free_string
func gvproxy_free_string(str *C.char) {
	C.free(unsafe.Pointer(str))
}

//export gvproxy_destroy
func gvproxy_destroy(id C.longlong) C.int {
	if !destroyGvproxy(int64(id)) {
		return -1
	}
	return 0
}

func destroyGvproxy(id int64) bool {
	instancesMu.Lock()
	instance, ok := instances[id]
	if ok {
		delete(instances, id)
	}
	instancesMu.Unlock()

	if !ok {
		return false
	}

	// Cancel context to stop goroutines
	instance.Cancel()
	if instance.managedDone != nil {
		<-instance.managedDone
	}

	logrus.Info("Destroyed gvproxy instance", "id", id)
	return true
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
