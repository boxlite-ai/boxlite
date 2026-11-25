package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"strings"
	"time"
)

type proxyFailure string

func (f proxyFailure) Error() string { return string(f) }

const (
	proxyUnreachable     proxyFailure = "proxy_unreachable"
	proxyAuthFailed      proxyFailure = "proxy_auth_failed"
	proxyHandshakeFailed proxyFailure = "proxy_handshake_failed"
	proxyTimeout         proxyFailure = "proxy_timeout"
)

// A candidate refusal keeps the same public diagnostic as other handshake
// failures. The by-name dialer can advance only on this explicit outcome.
var errProxyCandidate = fmt.Errorf("%w", proxyHandshakeFailed)

type proxyCredentials struct {
	username string
	password string
}

type proxyConnectorConfig struct {
	scheme     string
	endpoint   netip.AddrPort
	serverName string
	roots      *x509.CertPool
	credential *proxyCredentials
	protected  []netip.Prefix
}

func newProxyConnector(cfg proxyConnectorConfig, dial dialFunc) (connectFunc, error) {
	switch cfg.scheme {
	case "http", "socks5":
	case "https":
		if cfg.serverName == "" {
			return nil, errors.New("proxy TLS server name is required")
		}
	default:
		return nil, errors.New("unsupported proxy scheme")
	}
	if cfg.credential != nil {
		credential := *cfg.credential
		if !validProxyCredential(credential.username) || !validProxyCredential(credential.password) ||
			(cfg.scheme != "socks5" && strings.Contains(credential.username, ":")) {
			return nil, errors.New("invalid proxy credentials")
		}
		cfg.credential = &credential
	}
	for _, prefix := range cfg.protected {
		if !prefix.IsValid() || prefix.Addr().Is4In6() {
			return nil, errors.New("invalid protected proxy prefix")
		}
	}
	cfg.protected = append([]netip.Prefix(nil), cfg.protected...)
	if cfg.roots != nil {
		cfg.roots = cfg.roots.Clone()
	}
	if dial == nil {
		dial = (&net.Dialer{}).DialContext
	}
	return func(ctx context.Context, target egressTarget) (net.Conn, error) {
		return cfg.connect(ctx, dial, target)
	}, nil
}

func validProxyCredential(value string) bool {
	if len(value) == 0 || len(value) > 255 {
		return false
	}
	for _, c := range value {
		if c < ' ' || c > '~' {
			return false
		}
	}
	return true
}

func (cfg proxyConnectorConfig) connect(ctx context.Context, dial dialFunc, target egressTarget) (net.Conn, error) {
	ctx, cancel := context.WithTimeout(ctx, upstreamDialTimeout)
	defer cancel()
	if err := proxySetupError(ctx, nil); err != nil {
		return nil, err
	}
	if cfg.endpoint.Port() == 0 || target.Port == 0 ||
		!cfg.permitsAddress(cfg.endpoint.Addr(), false) || !cfg.permitsAddress(target.PolicyIP, true) {
		return nil, proxyHandshakeFailed
	}
	if !cfg.permitsAddress(target.ConnectionIP, true) {
		return nil, errProxyCandidate
	}

	endpoint := netip.AddrPortFrom(cfg.endpoint.Addr().Unmap(), cfg.endpoint.Port())
	raw, err := dial(ctx, "tcp", endpoint.String())
	if err != nil {
		if raw != nil {
			_ = raw.Close()
		}
		return nil, proxySetupError(ctx, proxyUnreachable)
	}
	stop := context.AfterFunc(ctx, func() { _ = raw.Close() })
	authority := netip.AddrPortFrom(target.ConnectionIP.Unmap(), target.Port)
	conn, err := cfg.negotiate(ctx, raw, authority)
	if err == nil && raw.SetDeadline(time.Time{}) != nil {
		err = proxyHandshakeFailed
	}
	// Keep cancellation armed through deadline clearing. A running callback
	// still owns the socket, even if setup completed successfully.
	if !stop() && err == nil {
		err = proxyHandshakeFailed
	}
	if err = proxySetupError(ctx, err); err != nil {
		_ = raw.Close()
		return nil, err
	}
	return conn, nil
}

func (cfg proxyConnectorConfig) negotiate(ctx context.Context, conn net.Conn, authority netip.AddrPort) (net.Conn, error) {
	deadline, _ := ctx.Deadline()
	if conn.SetDeadline(deadline) != nil {
		return nil, proxyHandshakeFailed
	}
	if cfg.scheme == "socks5" {
		return conn, connectSOCKS5(conn, authority, cfg.credential)
	}
	if cfg.scheme == "https" {
		client := tls.Client(conn, &tls.Config{
			ServerName: cfg.serverName,
			RootCAs:    cfg.roots,
			NextProtos: []string{"http/1.1"},
		})
		if client.HandshakeContext(ctx) != nil {
			return nil, proxyHandshakeFailed
		}
		conn = client
	}
	return connectHTTP(conn, authority.String(), cfg.credential)
}

func proxySetupError(ctx context.Context, fallback error) error {
	if ctx.Err() == context.Canceled {
		return context.Canceled
	}
	if deadline, ok := ctx.Deadline(); ok && !time.Now().Before(deadline) {
		return proxyTimeout
	}
	return fallback
}
