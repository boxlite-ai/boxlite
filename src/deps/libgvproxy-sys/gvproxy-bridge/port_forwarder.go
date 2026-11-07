package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"sync"

	"github.com/containers/gvisor-tap-vsock/pkg/services/forwarder"
	"github.com/containers/gvisor-tap-vsock/pkg/tcpproxy"
	"github.com/containers/gvisor-tap-vsock/pkg/types"
	"github.com/containers/gvisor-tap-vsock/pkg/virtualnetwork"
	"github.com/sirupsen/logrus"
)

type portMapping struct {
	types.ExposeRequest
	close func() error
}

// portForwarder owns the control API's mappings. TCP streams use BoxLite's
// relay; other transports keep the official dependency's implementation.
type portForwarder struct {
	ctx      context.Context
	dial     func(context.Context, string) (net.Conn, error)
	upstream *forwarder.PortsForwarder
	mu       sync.Mutex
	mappings map[string]portMapping
}

func newPortForwarder(ctx context.Context, vn *virtualnetwork.VirtualNetwork) (http.Handler, error) {
	s, err := stackOf(vn)
	if err != nil {
		return nil, err
	}
	f := &portForwarder{ctx: ctx, dial: vn.DialContextTCP,
		upstream: forwarder.NewPortsForwarder(s), mappings: make(map[string]portMapping)}
	context.AfterFunc(ctx, func() {
		f.mu.Lock()
		defer f.mu.Unlock()
		for key, mapping := range f.mappings {
			_ = mapping.close()
			delete(f.mappings, key)
		}
	})
	return f, nil
}

func (f *portForwarder) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/expose" && r.URL.Path != "/unexpose" && r.URL.Path != "/all" {
		http.NotFound(w, r)
		return
	}
	if r.URL.Path == "/all" {
		f.mu.Lock()
		mappings := make([]types.ExposeRequest, 0, len(f.mappings))
		for _, mapping := range f.mappings {
			mappings = append(mappings, mapping.ExposeRequest)
		}
		f.mu.Unlock()
		sort.Slice(mappings, func(i, j int) bool {
			if mappings[i].Local == mappings[j].Local {
				return mappings[i].Protocol < mappings[j].Protocol
			}
			return mappings[i].Local < mappings[j].Local
		})
		_ = json.NewEncoder(w).Encode(mappings)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "post only", http.StatusBadRequest)
		return
	}
	var req types.ExposeRequest
	var decodeErr error
	if r.URL.Path == "/unexpose" {
		var unexpose types.UnexposeRequest
		decodeErr = json.NewDecoder(r.Body).Decode(&unexpose)
		req.Local, req.Protocol = unexpose.Local, unexpose.Protocol
	} else {
		decodeErr = json.NewDecoder(r.Body).Decode(&req)
	}
	if decodeErr != nil {
		http.Error(w, decodeErr.Error(), http.StatusBadRequest)
		return
	}
	if req.Protocol == "" {
		req.Protocol = types.TCP
	}
	if r.URL.Path == "/expose" && req.Protocol != types.UNIX && req.Protocol != types.NPIPE {
		host, port, err := net.SplitHostPort(req.Remote)
		if err == nil && host == "" {
			host, _, err = net.SplitHostPort(r.RemoteAddr)
			if err == nil {
				req.Remote = net.JoinHostPort(host, port)
			}
		}
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	key := string(req.Protocol) + "/" + req.Local
	var err error
	if r.URL.Path == "/expose" {
		err = f.expose(key, req)
	} else if mapping, ok := f.mappings[key]; ok {
		delete(f.mappings, key)
		err = mapping.close()
	} else {
		err = errors.New("proxy not found")
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

// Called with mu held so registration and instance shutdown cannot cross.
func (f *portForwarder) expose(key string, req types.ExposeRequest) error {
	if err := f.ctx.Err(); err != nil {
		return err
	}
	if _, ok := f.mappings[key]; ok {
		return errors.New("proxy already running")
	}
	remote := req.Remote
	useTCPRelay := req.Protocol == types.TCP
	if req.Protocol == types.UNIX {
		u, err := url.Parse(remote)
		if err != nil {
			return err
		}
		if u.Scheme == "tcp" {
			useTCPRelay, remote = true, u.Host
		}
	}
	var closeMapping func() error
	if useTCPRelay {
		p, err := f.listenTCP(req, remote)
		if err != nil {
			return err
		}
		closeMapping = p.Close
	} else {
		if err := f.upstream.Expose(req.Protocol, req.Local, req.Remote); err != nil {
			return err
		}
		closeMapping = func() error { return f.upstream.Unexpose(req.Protocol, req.Local) }
	}
	f.mappings[key] = portMapping{ExposeRequest: req, close: closeMapping}
	return nil
}

func (f *portForwarder) listenTCP(req types.ExposeRequest, remote string) (*tcpproxy.Proxy, error) {
	host, port, err := net.SplitHostPort(remote)
	if err != nil {
		return nil, err
	}
	if net.ParseIP(host).To4() == nil {
		return nil, fmt.Errorf("remote must contain an IPv4 address")
	}
	if _, err := strconv.ParseUint(port, 10, 16); err != nil {
		return nil, err
	}
	p := &tcpproxy.Proxy{}
	if req.Protocol == types.UNIX {
		p.ListenFunc = func(_, path string) (net.Listener, error) {
			if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
				return nil, err
			}
			return net.Listen("unix", path)
		}
	}
	p.AddRoute(req.Local, &relayTarget{ctx: f.ctx, addr: remote, dial: f.dial})
	if err := p.Start(); err != nil {
		return nil, err
	}
	go func() {
		if err := p.Wait(); err != nil && !errors.Is(err, net.ErrClosed) {
			logrus.WithError(err).Warn("port forward listener ended")
		}
	}()
	return p, nil
}
