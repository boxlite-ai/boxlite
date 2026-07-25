package main

import (
	"bufio"
	"context"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Deliberately mirrors maxConcurrentPortMappingConnections so changing the
// production boundary requires an explicit test update.
const testPortMappingConnectionLimit = 256

func TestBindPortMappingsResolvesAndKeepsAutomaticPort(t *testing.T) {
	listeners, resolved, err := bindPortMappings([]PortMapping{{
		HostPort:  0,
		GuestPort: 3000,
		Protocol:  "tcp",
	}})
	if err != nil {
		t.Fatalf("bind automatic mapping: %v", err)
	}
	defer closeListeners(listeners)

	if len(resolved) != 1 || resolved[0].HostPort == 0 {
		t.Fatalf("expected one resolved non-zero host port, got %+v", resolved)
	}

	addr := net.JoinHostPort(resolved[0].HostIP, portString(resolved[0].HostPort))
	probe, err := net.Listen("tcp", addr)
	if err == nil {
		probe.Close()
		t.Fatalf("resolved address %s was not kept reserved", addr)
	}
}

func TestBindPortMappingsRollsBackAllListenersOnConflict(t *testing.T) {
	reservation, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve test port: %v", err)
	}
	port := uint16(reservation.Addr().(*net.TCPAddr).Port)
	reservation.Close()

	mapping := PortMapping{
		HostPort:  port,
		GuestPort: 3000,
		HostIP:    "127.0.0.1",
		Protocol:  "tcp",
	}
	listeners, _, err := bindPortMappings([]PortMapping{mapping, mapping})
	if err == nil {
		closeListeners(listeners)
		t.Fatal("expected duplicate fixed endpoint to fail")
	}

	probe, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", portString(port)))
	if err != nil {
		t.Fatalf("failed transaction leaked its first listener: %v", err)
	}
	probe.Close()
}

func TestBindPortMappingsReservesFixedPortsBeforeAutomaticPorts(t *testing.T) {
	reservation, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve test port: %v", err)
	}
	fixedPort := uint16(reservation.Addr().(*net.TCPAddr).Port)
	reservation.Close()

	var bindOrder []string
	listeners, resolved, err := bindPortMappingsWith(
		[]PortMapping{
			{GuestPort: 3000, HostIP: "127.0.0.1", Protocol: "tcp"},
			{HostPort: fixedPort, GuestPort: 8080, HostIP: "127.0.0.1", Protocol: "tcp"},
		},
		func(network string, address string) (net.Listener, error) {
			bindOrder = append(bindOrder, address)
			return net.Listen(network, address)
		},
	)
	if err != nil {
		t.Fatalf("bind mixed plan: %v", err)
	}
	defer closeListeners(listeners)

	wantFirst := net.JoinHostPort("127.0.0.1", portString(fixedPort))
	if len(bindOrder) != 2 || bindOrder[0] != wantFirst {
		t.Fatalf("fixed endpoint was not reserved first: got %v, want first %s", bindOrder, wantFirst)
	}
	if resolved[0].GuestPort != 3000 || resolved[0].HostPort == 0 {
		t.Fatalf("automatic mapping did not retain request order: %+v", resolved)
	}
	if resolved[1].GuestPort != 8080 || resolved[1].HostPort != fixedPort {
		t.Fatalf("fixed mapping did not retain request order: %+v", resolved)
	}
}

func TestCloseConnectionsOnCancelClosesEstablishedConnection(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	connection, peer := net.Pipe()
	stop := closeConnectionsOnCancel(ctx, connection)
	defer stop()
	defer peer.Close()

	cancel()
	_ = peer.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := peer.Read(make([]byte, 1)); err == nil {
		t.Fatal("peer read remained open after cancellation")
	}
}

func TestServePortMappingRejectsConnectionsAboveLimit(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())

	controlDirectory, err := os.MkdirTemp("/tmp", "boxlite-port-test-")
	if err != nil {
		t.Fatalf("create short control socket directory: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(controlDirectory) })

	controlSocketPath := filepath.Join(controlDirectory, "control.sock")
	controlListener, err := net.Listen("unix", controlSocketPath)
	if err != nil {
		t.Fatalf("listen on control socket: %v", err)
	}
	defer controlListener.Close()

	acceptedTunnels := make(chan net.Conn, testPortMappingConnectionLimit+1)
	controlErrors := make(chan error, 1)
	go acceptTestControlTunnels(controlListener, acceptedTunnels, controlErrors)

	hostListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen on host port: %v", err)
	}
	defer hostListener.Close()

	go servePortMapping(ctx, hostListener, controlSocketPath, "192.168.127.2", 3000)

	var hostConnections []net.Conn
	var tunnelConnections []net.Conn
	defer func() {
		for _, connection := range hostConnections {
			_ = connection.Close()
		}
		for _, connection := range tunnelConnections {
			_ = connection.Close()
		}
	}()
	defer cancel()

	for index := 0; index < testPortMappingConnectionLimit; index++ {
		connection, err := net.Dial("tcp", hostListener.Addr().String())
		if err != nil {
			t.Fatalf("dial allowed host connection %d: %v", index, err)
		}
		hostConnections = append(hostConnections, connection)

		select {
		case tunnel := <-acceptedTunnels:
			tunnelConnections = append(tunnelConnections, tunnel)
		case err := <-controlErrors:
			t.Fatalf("accept allowed control tunnel %d: %v", index, err)
		case <-time.After(5 * time.Second):
			t.Fatalf("timed out waiting for allowed control tunnel %d", index)
		}
	}

	excessConnection, err := net.Dial("tcp", hostListener.Addr().String())
	if err != nil {
		t.Fatalf("dial excess host connection: %v", err)
	}
	hostConnections = append(hostConnections, excessConnection)

	if err := excessConnection.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatalf("set excess connection deadline: %v", err)
	}
	if _, err := excessConnection.Read(make([]byte, 1)); err == nil {
		t.Fatal("excess host connection unexpectedly returned data")
	} else if timeout, ok := err.(net.Error); ok && timeout.Timeout() {
		t.Fatal("excess host connection remained open after the limit was reached")
	}

	select {
	case tunnel := <-acceptedTunnels:
		_ = tunnel.Close()
		t.Fatal("excess host connection opened a gvproxy control tunnel")
	default:
	}
}

func acceptTestControlTunnels(
	listener net.Listener,
	accepted chan<- net.Conn,
	controlErrors chan<- error,
) {
	for {
		connection, err := listener.Accept()
		if err != nil {
			return
		}

		request, err := http.ReadRequest(bufio.NewReader(connection))
		if err != nil {
			_ = connection.Close()
			controlErrors <- err
			return
		}
		_ = request.Body.Close()

		if _, err := connection.Write([]byte("OK")); err != nil {
			_ = connection.Close()
			controlErrors <- err
			return
		}
		accepted <- connection
	}
}
