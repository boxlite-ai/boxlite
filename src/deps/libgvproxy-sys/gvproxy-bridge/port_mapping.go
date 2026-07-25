package main

import (
	"context"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"

	"github.com/containers/gvisor-tap-vsock/pkg/transport"
	logrus "github.com/sirupsen/logrus"
)

const (
	defaultPortBindIP                   = "0.0.0.0"
	maxConcurrentPortMappingConnections = 256
)

// bindPortMappings validates and binds the whole publication plan before the VM
// starts. Holding every listener makes automatic allocation race-free and gives
// fixed mappings all-or-nothing startup semantics.
func bindPortMappings(requested []PortMapping) ([]net.Listener, []PortMapping, error) {
	return bindPortMappingsWith(requested, net.Listen)
}

type listenPortFunc func(network string, address string) (net.Listener, error)

func bindPortMappingsWith(
	requested []PortMapping,
	listen listenPortFunc,
) ([]net.Listener, []PortMapping, error) {
	listeners := make([]net.Listener, len(requested))
	resolved := make([]PortMapping, len(requested))

	// Fixed endpoints are reserved before automatic ones so an ephemeral
	// allocation cannot consume a port explicitly requested later in the plan.
	for _, automatic := range []bool{false, true} {
		for index, mapping := range requested {
			if (mapping.HostPort == 0) != automatic {
				continue
			}

			if mapping.GuestPort == 0 {
				closeListeners(listeners)
				return nil, nil, fmt.Errorf("port mapping %d has guest_port 0", index)
			}

			protocol := strings.ToLower(mapping.Protocol)
			if protocol == "" {
				protocol = "tcp"
			}
			if protocol != "tcp" {
				closeListeners(listeners)
				return nil, nil, fmt.Errorf(
					"port mapping %d uses unsupported protocol %q; only tcp is supported",
					index,
					mapping.Protocol,
				)
			}

			hostIP := mapping.HostIP
			if hostIP == "" {
				hostIP = defaultPortBindIP
			}
			if net.ParseIP(hostIP) == nil {
				closeListeners(listeners)
				return nil, nil, fmt.Errorf("port mapping %d has invalid host_ip %q", index, hostIP)
			}

			local := net.JoinHostPort(hostIP, portString(mapping.HostPort))
			listener, err := listen("tcp", local)
			if err != nil {
				closeListeners(listeners)
				return nil, nil, fmt.Errorf(
					"bind tcp %s for guest port %d: %w",
					local,
					mapping.GuestPort,
					err,
				)
			}

			tcpAddress, ok := listener.Addr().(*net.TCPAddr)
			if !ok || tcpAddress.Port < 1 || tcpAddress.Port > 65535 {
				_ = listener.Close()
				closeListeners(listeners)
				return nil, nil, fmt.Errorf(
					"listener for guest port %d returned invalid address %s",
					mapping.GuestPort,
					listener.Addr(),
				)
			}

			mapping.HostPort = uint16(tcpAddress.Port)
			mapping.HostIP = hostIP
			mapping.Protocol = "tcp"
			listeners[index] = listener
			resolved[index] = mapping
		}
	}

	return listeners, resolved, nil
}

func closeListeners(listeners []net.Listener) {
	for _, listener := range listeners {
		if listener != nil {
			_ = listener.Close()
		}
	}
}

func portString(port uint16) string {
	return strconv.FormatUint(uint64(port), 10)
}

// servePortMapping accepts host connections on an already-bound listener and
// opens a gvproxy tunnel to the guest for each one. The pre-bound listener is
// the allocation authority; gvproxy never re-binds the selected port.
func servePortMapping(
	ctx context.Context,
	listener net.Listener,
	controlSocketPath string,
	guestIP string,
	guestPort uint16,
) {
	connectionSlots := make(chan struct{}, maxConcurrentPortMappingConnections)

	for {
		hostConnection, err := listener.Accept()
		if err != nil {
			if ctx.Err() == nil {
				logrus.WithFields(logrus.Fields{
					"error": err,
					"local": listener.Addr().String(),
				}).Error("Host port listener stopped")
			}
			return
		}

		select {
		case connectionSlots <- struct{}{}:
			go func(connection net.Conn) {
				defer func() { <-connectionSlots }()
				proxyPortConnection(ctx, connection, controlSocketPath, guestIP, guestPort)
			}(hostConnection)
		default:
			_ = hostConnection.Close()
			logrus.WithFields(logrus.Fields{
				"guest_port": guestPort,
				"limit":      maxConcurrentPortMappingConnections,
				"local":      listener.Addr().String(),
			}).Debug("Rejected host port connection: concurrent connection limit reached")
		}
	}
}

func proxyPortConnection(
	ctx context.Context,
	hostConnection net.Conn,
	controlSocketPath string,
	guestIP string,
	guestPort uint16,
) {
	defer hostConnection.Close()

	dialer := net.Dialer{}
	tunnelConnection, err := dialer.DialContext(ctx, "unix", controlSocketPath)
	if err != nil {
		logrus.WithFields(logrus.Fields{
			"error":      err,
			"guest_port": guestPort,
		}).Warn("Failed to open gvproxy control connection for host port")
		return
	}
	defer tunnelConnection.Close()

	stopCancelWatcher := closeConnectionsOnCancel(ctx, hostConnection, tunnelConnection)
	defer stopCancelWatcher()

	if err := transport.Tunnel(tunnelConnection, guestIP, int(guestPort)); err != nil {
		logrus.WithFields(logrus.Fields{
			"error":      err,
			"guest_port": guestPort,
		}).Warn("Failed to establish gvproxy guest tunnel for host port")
		return
	}

	hostToGuestDone := make(chan struct{})
	go func() {
		_, _ = io.Copy(tunnelConnection, hostConnection)
		closeWrite(tunnelConnection)
		close(hostToGuestDone)
	}()

	_, _ = io.Copy(hostConnection, tunnelConnection)
	closeWrite(hostConnection)
	<-hostToGuestDone
}

func closeConnectionsOnCancel(ctx context.Context, connections ...net.Conn) func() {
	stopped := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			for _, connection := range connections {
				_ = connection.Close()
			}
		case <-stopped:
		}
	}()
	return func() {
		close(stopped)
	}
}

func closeWrite(connection net.Conn) {
	type closeWriter interface {
		CloseWrite() error
	}
	if writer, ok := connection.(closeWriter); ok {
		_ = writer.CloseWrite()
	}
}
