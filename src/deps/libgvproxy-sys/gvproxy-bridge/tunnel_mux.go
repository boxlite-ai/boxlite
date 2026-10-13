package main

import (
	"context"
	"net"
	"net/http"
	"strconv"

	"github.com/containers/gvisor-tap-vsock/pkg/tcpproxy"
)

// controlMux is what the control socket serves: gvproxy's ServicesMux with
// /tunnel replaced.
//
// gvproxy's own /tunnel writes its "OK" ack before it dials the guest, so a
// port nothing listens on still acks and the pipe then just closes. Callers
// cannot tell "service not up yet" from a live stream; the preview proxy needs
// that to keep retrying while a resumed box's cmd starts. This /tunnel dials
// first and acks only a connection the guest accepted.
//
// services is gvproxy's ServicesMux and dial reaches the guest network
// (vn.DialContextTCP in production).
func controlMux(services http.Handler, dial func(ctx context.Context, addr string) (net.Conn, error)) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("/", services)
	mux.HandleFunc("/tunnel", dialFirstTunnel(dial))
	return mux
}

func dialFirstTunnel(dial func(ctx context.Context, addr string) (net.Conn, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "post only", http.StatusMethodNotAllowed)
			return
		}
		ip := r.URL.Query().Get("ip")
		port, err := strconv.ParseUint(r.URL.Query().Get("port"), 10, 16)
		if ip == "" || err != nil {
			http.Error(w, "ip and port are mandatory", http.StatusBadRequest)
			return
		}
		guest, err := dial(r.Context(), net.JoinHostPort(ip, strconv.FormatUint(port, 10)))
		if err != nil {
			http.Error(w, "cannot dial guest: "+err.Error(), http.StatusBadGateway)
			return
		}
		hj, ok := w.(http.Hijacker)
		if !ok {
			guest.Close()
			http.Error(w, "webserver doesn't support hijacking", http.StatusInternalServerError)
			return
		}
		conn, bufrw, err := hj.Hijack()
		if err != nil {
			guest.Close()
			return
		}
		defer conn.Close()
		if err := bufrw.Flush(); err != nil {
			guest.Close()
			return
		}
		if _, err := conn.Write([]byte(`OK`)); err != nil {
			guest.Close()
			return
		}
		// Same relay as gvproxy's /tunnel, fed the connection dialed above.
		(&tcpproxy.DialProxy{
			DialContext: func(context.Context, string, string) (net.Conn, error) { return guest, nil },
		}).HandleConn(conn)
	}
}
