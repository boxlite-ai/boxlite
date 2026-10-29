package transport

import (
	"net"

	"github.com/pkg/errors"
)

func Dial(_ string) (net.Conn, string, error) {
	return nil, "", errors.New("unsupported")
}
