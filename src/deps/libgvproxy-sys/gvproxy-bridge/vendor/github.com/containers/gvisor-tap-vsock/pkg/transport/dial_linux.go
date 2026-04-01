package transport

import (
	"fmt"
	"net"
	"net/url"
	"strconv"

	"github.com/containers/gvisor-tap-vsock/pkg/net/stdio"
	mdlayhervsock "github.com/mdlayher/vsock"
	"github.com/pkg/errors"
)

func Dial(endpoint string) (net.Conn, string, error) {
	parsed, err := url.Parse(endpoint)
	if err != nil {
		return nil, "", err
	}
	switch parsed.Scheme {
	case "vsock":
		contextID, err := strconv.ParseUint(parsed.Hostname(), 10, 32)
		if err != nil {
			return nil, "", err
		}
		port, err := strconv.ParseUint(parsed.Port(), 10, 32)
		if err != nil {
			return nil, "", err
		}
		conn, err := mdlayhervsock.Dial(uint32(contextID), uint32(port), nil)
		return conn, parsed.Path, err
	case "unix":
		conn, err := net.Dial("unix", parsed.Path)
		return conn, "/connect", err
	case "stdio":
		var values []string
		for k, vs := range parsed.Query() {
			for _, v := range vs {
				values = append(values, fmt.Sprintf("-%s=%s", k, v))
			}
		}
		conn, err := stdio.Dial(parsed.Path, values...)
		return conn, "", err
	default:
		return nil, "", errors.New("unexpected scheme")
	}
}
