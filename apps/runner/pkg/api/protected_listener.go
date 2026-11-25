// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package api

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"slices"
	"strings"
	"sync"
	"time"

	common_errors "github.com/boxlite-ai/common-go/pkg/errors"
	"github.com/boxlite-ai/runner/pkg/api/middlewares"
	"github.com/boxlite-ai/runner/pkg/common"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

type ProtectedListenerConfig struct {
	Address       string
	CertFile      string
	KeyFile       string
	ClientCAFile  string
	ClientDNSName string
}

// StartProtectedListener binds the optional V2 endpoint independently of the
// ordinary server. The returned function cancels requests and joins the listener.
func StartProtectedListener(ctx context.Context, logger *slog.Logger, config ProtectedListenerConfig, boot ProtectedBootConfig, token string) (net.Addr, func(), error) {
	if !boot.validPin() || strings.TrimSpace(token) == "" {
		return nil, nil, errors.New("protected listener requires a valid Runner pin and token")
	}
	credentials, err := config.tlsConfig()
	if err != nil {
		return nil, nil, err
	}
	listener, err := (&net.ListenConfig{}).Listen(ctx, "tcp", config.Address)
	if err != nil {
		return nil, nil, fmt.Errorf("bind protected listener: %w", err)
	}

	router := gin.New()
	router.Use(common_errors.Recovery(), common_errors.NewErrorMiddleware(common.HandlePossibleDockerError))
	protected := protectedBootGroup(router.Group("/", middlewares.AuthMiddleware(token)), boot)
	registerProtectedBootCapability(protected, boot, 2, uuid.NewString(), []string{})
	requestCtx, cancel := context.WithCancel(ctx)
	server := &http.Server{
		Handler:           router,
		TLSConfig:         credentials,
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
		BaseContext:       func(net.Listener) context.Context { return requestCtx },
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer listener.Close()
		if err := server.ServeTLS(listener, "", ""); err != nil && !errors.Is(err, http.ErrServerClosed) {
			cancel()
			_ = server.Close()
			logger.Error("Protected listener stopped", "error", err)
		}
	}()

	return listener.Addr(), sync.OnceFunc(func() {
		cancel()
		drainCtx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		if err := server.Shutdown(drainCtx); err != nil {
			logger.Warn("Protected listener shutdown timed out", "error", err)
			_ = server.Close()
		}
		<-done
	}), nil
}

func (c ProtectedListenerConfig) tlsConfig() (*tls.Config, error) {
	if c.ClientDNSName == "" || strings.Contains(c.ClientDNSName, "*") {
		return nil, errors.New("protected listener requires an exact API client DNS SAN")
	}
	certificate, err := tls.LoadX509KeyPair(c.CertFile, c.KeyFile)
	if err != nil {
		return nil, fmt.Errorf("load protected listener key pair: %w", err)
	}
	ca, err := os.ReadFile(c.ClientCAFile)
	if err != nil {
		return nil, fmt.Errorf("read protected listener client CA: %w", err)
	}
	roots := x509.NewCertPool()
	hasClientCA := false
	for len(ca) > 0 {
		var block *pem.Block
		block, ca = pem.Decode(ca)
		if block == nil {
			break
		}
		certificate, err := x509.ParseCertificate(block.Bytes)
		if err != nil || block.Type != "CERTIFICATE" || !certificate.IsCA {
			return nil, errors.New("protected listener client CA contains an invalid CA certificate")
		}
		roots.AddCert(certificate)
		hasClientCA = true
	}
	if !hasClientCA {
		return nil, errors.New("protected listener client CA contains no certificates")
	}
	return &tls.Config{
		Certificates: []tls.Certificate{certificate},
		ClientAuth:   tls.RequireAndVerifyClientCert,
		ClientCAs:    roots,
		MinVersion:   tls.VersionTLS12,
		VerifyConnection: func(state tls.ConnectionState) error {
			if !slices.Contains(state.PeerCertificates[0].DNSNames, c.ClientDNSName) {
				return errors.New("protected listener client DNS SAN does not match")
			}
			return nil
		},
	}, nil
}
