package main

import (
	"context"
	"errors"
	"net"
	"sync/atomic"
	"testing"
	"time"
)

func TestRegisteredProxyLiteralSkipsBootstrap(t *testing.T) {
	cfg := proxyTestConfig("http")
	peer := startProxyTestPeer(t, func(conn *net.TCPConn) error {
		if err := readTestProxyCONNECT(conn, "93.184.216.34:443", ""); err != nil {
			return err
		}
		_, err := conn.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n"))
		return err
	})
	var lookups atomic.Int32
	connect, err := newRegisteredProxyConnector(cfg, cfg.endpoint.Addr().String(), cfg.endpoint.Port(),
		func(_ context.Context, name string) ([]net.IP, error) {
			lookups.Add(1)
			return nil, errors.New("unexpected lookup for " + name)
		}, proxyTestDial(peer, cfg.endpoint))
	if err != nil {
		t.Fatal(err)
	}
	conn, err := connect(context.Background(), proxyTestTarget(proxyTestFirstIP))
	if err != nil {
		t.Fatal(err)
	}
	_ = conn.Close()
	peer.check(t)
	if lookups.Load() != 0 {
		t.Fatalf("literal proxy caused %d bootstrap lookups", lookups.Load())
	}
}

func TestRegisteredProxyBootstrapDeadlinePreventsDial(t *testing.T) {
	cfg := proxyTestConfig("http")
	var dials atomic.Int32
	var lookupName string
	connect, err := newRegisteredProxyConnector(cfg, proxyTestTLSName, cfg.endpoint.Port(),
		func(ctx context.Context, name string) ([]net.IP, error) {
			lookupName = name
			<-ctx.Done()
			return nil, ctx.Err()
		}, func(_ context.Context, _, _ string) (net.Conn, error) {
			dials.Add(1)
			return nil, errors.New("unexpected dial")
		})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	conn, err := connect(ctx, proxyTestTarget(proxyTestFirstIP))
	requireProxyFailure(t, conn, err, proxyTimeout)
	if lookupName != proxyTestTLSName+"." || dials.Load() != 0 {
		t.Fatalf("lookup=%q, dials=%d", lookupName, dials.Load())
	}
}
