/*
 * Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

package main

import (
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"fmt"
	"net"
	"os"
	"strconv"

	"golang.org/x/crypto/ssh"

	log "github.com/sirupsen/logrus"
)

const (
	defaultPort = 2222
)

// The Legacy SSH Token contract (`POST`/`DELETE /box/{id}/ssh-access` and
// `GET /box/ssh-access/validate`) was deleted, so this gateway has no way to
// map a username to a box and must never authenticate anyone. The service and
// its infrastructure stay deployed only as rollback protection for the
// certificate-based SSH rollout; it fails closed until Phase 5 cleanup removes
// it entirely.
var errTokenAuthRemoved = fmt.Errorf("ssh token authentication has been removed")

const tokenAuthRemovedBanner = "BoxLite SSH gateway: token authentication has been removed.\r\n" +
	"Connect to the box over the direct tunnel on port 22 with a BoxLite-issued SSH certificate.\r\n"

type SSHGateway struct {
	port    int
	hostKey ssh.Signer
}

func main() {
	port := getEnvInt("SSH_GATEWAY_PORT", defaultPort)
	sshHostKey := getEnv("SSH_HOST_KEY", "")

	// No API_URL/API_KEY: this gateway makes no API calls. The only startup
	// requirement left is a host key, so the listener can present a stable
	// identity while it refuses every connection.
	if sshHostKey == "" {
		log.Fatal("SSH_HOST_KEY environment variable is required")
	}

	// Decode base64 encoded host key
	decodedHostKey, err := base64.StdEncoding.DecodeString(sshHostKey)
	if err != nil {
		log.Fatalf("Failed to base64 decode SSH_HOST_KEY: %v", err)
	}

	// Load the host key from environment variable
	hostKey, err := parsePrivateKey(string(decodedHostKey))
	if err != nil {
		log.Fatalf("Failed to parse host key from SSH_HOST_KEY: %v", err)
	}

	gateway := &SSHGateway{
		port:    port,
		hostKey: hostKey,
	}

	log.Printf("Host key loaded from SSH_HOST_KEY environment variable (base64 decoded)")

	log.Printf("Starting SSH Gateway on port %d", port)
	if err := gateway.Start(); err != nil {
		log.Fatalf("Failed to start SSH Gateway: %v", err)
	}
}

func (g *SSHGateway) Start() error {
	serverConfig := &ssh.ServerConfig{
		// Fail closed: every authentication method is refused, and the banner
		// tells the user why before the handshake is torn down.
		NoClientAuth: false,
		BannerCallback: func(conn ssh.ConnMetadata) string {
			return tokenAuthRemovedBanner
		},
		PasswordCallback: func(conn ssh.ConnMetadata, password []byte) (*ssh.Permissions, error) {
			return nil, errTokenAuthRemoved
		},
		PublicKeyCallback: func(conn ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
			return nil, errTokenAuthRemoved
		},
		KeyboardInteractiveCallback: func(conn ssh.ConnMetadata, client ssh.KeyboardInteractiveChallenge) (*ssh.Permissions, error) {
			return nil, errTokenAuthRemoved
		},
		AuthLogCallback: func(conn ssh.ConnMetadata, method string, err error) {
			if err != nil {
				log.Printf("Authentication refused for user %s (method %s): %v", conn.User(), method, err)
			}
		},
	}

	// Add host key
	serverConfig.AddHostKey(g.hostKey)

	listener, err := net.Listen("tcp", fmt.Sprintf(":%d", g.port))
	if err != nil {
		return fmt.Errorf("failed to listen on port %d: %w", g.port, err)
	}
	defer listener.Close()

	log.Printf("SSH Gateway listening on port %d", g.port)

	for {
		conn, err := listener.Accept()
		if err != nil {
			log.Printf("Failed to accept incoming connection: %v", err)
			continue
		}

		go g.handleConnection(conn, serverConfig)
	}
}

func (g *SSHGateway) handleConnection(conn net.Conn, serverConfig *ssh.ServerConfig) {
	defer conn.Close()

	// Authentication is refused unconditionally in Start(), so the handshake
	// never completes and nothing is ever proxied to a runner.
	serverConn, _, _, err := ssh.NewServerConn(conn, serverConfig)
	if err != nil {
		log.Printf("Rejected SSH connection from %s: %v", conn.RemoteAddr(), err)
		return
	}

	// Unreachable while every auth callback rejects; kept so a future auth
	// change cannot silently re-open the proxy path.
	log.Printf("Closing unexpected authenticated SSH connection for user %s", serverConn.User())
	serverConn.Close()
}

func parsePrivateKey(privateKeyPEM string) (ssh.Signer, error) {
	// First try to parse as OpenSSH format (newer format)
	signer, err := ssh.ParsePrivateKey([]byte(privateKeyPEM))
	if err == nil {
		return signer, nil
	}

	// If OpenSSH parsing fails, try PKCS1 format (older format)
	block, _ := pem.Decode([]byte(privateKeyPEM))
	if block == nil {
		return nil, fmt.Errorf("failed to decode PEM block")
	}

	privateKey, err := x509.ParsePKCS1PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("failed to parse private key (tried OpenSSH and PKCS1 formats): %w", err)
	}

	signer, err = ssh.NewSignerFromKey(privateKey)
	if err != nil {
		return nil, fmt.Errorf("failed to create SSH signer: %w", err)
	}

	return signer, nil
}

func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

func getEnvInt(key string, defaultValue int) int {
	if value := os.Getenv(key); value != "" {
		if intValue, err := strconv.Atoi(value); err == nil {
			return intValue
		}
	}
	return defaultValue
}
