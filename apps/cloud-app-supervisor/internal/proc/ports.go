package proc

import (
	"fmt"
	"net"
	"strconv"
	"time"
)

// The exposed service's PORT is drawn from this private range rather than the
// conventional 3000/8000: an app that hardcodes 3000 for something else (a dev
// proxy, a second listener) would otherwise collide with the port the
// supervisor assigned, and the failure would look like a flaky health check.
const (
	PortMin = 20000
	PortMax = 20100
)

// FreePort returns a port in [PortMin, PortMax] that is not in exclude and
// accepts a bind on 127.0.0.1 and has no listener answering on it right now.
//
// The caller passes the live release's port as exclude: during a deploy the
// new instance must listen next to the old one for the health gate, so the
// two releases always alternate between distinct ports. The check is not
// atomic with the service's own bind, but the range is reserved for the
// supervisor and nothing else in the Box is expected to use it.
func FreePort(exclude ...int) (int, error) {
	skip := map[int]bool{}
	for _, p := range exclude {
		skip[p] = true
	}
	for p := PortMin; p <= PortMax; p++ {
		if skip[p] {
			continue
		}
		if !bindable("127.0.0.1", p) || answers(p) {
			// The connect probe: on macOS a bind succeeds next to another
			// process's *:p listener (SO_REUSEADDR), so binding alone would
			// hand out a port someone already serves on.
			continue
		}
		return p, nil
	}
	return 0, fmt.Errorf("no free port in %d-%d", PortMin, PortMax)
}

func answers(port int) bool {
	c, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), 100*time.Millisecond)
	if err != nil {
		return false
	}
	c.Close()
	return true
}

func bindable(host string, port int) bool {
	l, err := net.Listen("tcp", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		return false
	}
	l.Close()
	return true
}
