package transport

import (
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
)

func Tunnel(conn net.Conn, ip string, port int) error {
	req, err := http.NewRequest("POST", fmt.Sprintf("/tunnel?ip=%s&port=%d", ip, port), nil)
	if err != nil {
		return err
	}
	if err := req.Write(conn); err != nil {
		return err
	}

	ok := make([]byte, 2)
	if _, err := io.ReadFull(conn, ok); err != nil {
		return err
	}
	if string(ok) != "OK" {
		return errors.New("handshake failed")
	}
	return nil
}
