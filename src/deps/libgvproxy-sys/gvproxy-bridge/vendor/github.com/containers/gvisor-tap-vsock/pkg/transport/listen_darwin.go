package transport

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path"
	"strconv"
)

const DefaultURL = "vsock://null:1024/vm_directory"

func listenURL(parsed *url.URL) (net.Listener, error) {
	switch parsed.Scheme {
	case "vsock":
		port, err := strconv.Atoi(parsed.Port())
		if err != nil {
			return nil, err
		}
		path := path.Join(parsed.Path, fmt.Sprintf("00000002.%08x", port))
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return nil, err
		}
		return net.ListenUnix("unix", &net.UnixAddr{
			Name: path,
			Net:  "unix",
		})
	default:
		return defaultListenURL(parsed)
	}
}

func ListenUnixgram(endpoint string) (*net.UnixConn, error) {
	parsed, err := url.Parse(endpoint)
	if err != nil {
		return nil, err
	}
	if parsed.Scheme != "unixgram" {
		return nil, errors.New("unexpected scheme")
	}
	return net.ListenUnixgram("unixgram", &net.UnixAddr{
		Name: parsed.Path,
		Net:  "unixgram",
	})
}
