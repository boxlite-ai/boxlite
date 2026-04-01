//go:build !darwin && !linux && !windows
// +build !darwin,!linux,!windows

package transport

import (
	"net"
	"net/url"
)

func listenURL(url *url.URL) (net.Listener, error) {
	return defaultListenURL(url)
}
