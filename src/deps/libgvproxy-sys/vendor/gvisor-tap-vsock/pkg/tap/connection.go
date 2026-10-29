package tap

import (
	"net"
)

type protocolConn struct {
	net.Conn
	protocolImpl protocol
}
