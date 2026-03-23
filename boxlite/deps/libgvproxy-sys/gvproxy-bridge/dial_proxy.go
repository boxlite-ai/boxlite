package main

import (
	"fmt"
	"net"

	logrus "github.com/sirupsen/logrus"
)

// proxyDialFunc returns a dial function that routes connections through
// a Unix socket proxy. The proxy receives the destination as "host:port\n"
// and then relays bytes bidirectionally.
//
// When no proxy is needed (no AllowNet/Secrets), this returns nil
// and gvproxy uses net.Dial directly (zero overhead).
func proxyDialFunc(socketPath string) func(string, string) (net.Conn, error) {
	return func(network, address string) (net.Conn, error) {
		conn, err := net.Dial("unix", socketPath)
		if err != nil {
			logrus.WithFields(logrus.Fields{
				"socket":  socketPath,
				"address": address,
				"error":   err,
			}).Error("proxy_dial: failed to connect to proxy")
			return nil, fmt.Errorf("proxy connection failed: %w", err)
		}

		// Send destination address to proxy
		if _, err := fmt.Fprintf(conn, "%s\n", address); err != nil {
			conn.Close()
			return nil, fmt.Errorf("proxy handshake failed: %w", err)
		}

		logrus.WithFields(logrus.Fields{
			"address": address,
		}).Trace("proxy_dial: routed through proxy")

		return conn, nil
	}
}
