//go:build !windows
// +build !windows

package sshclient

import (
	"errors"
	"net"
	"net/url"
)

func ListenNpipe(_ *url.URL) (net.Listener, error) {
	return nil, errors.New("named pipes are not supported by this platform")
}
