package main

import (
	"context"
	"io"
	"net"
	"net/http"
	"strconv"

	"github.com/boxlite-ai/tcprelay"
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
		defer guest.Close()
		hj, ok := w.(http.Hijacker)
		if !ok {
			http.Error(w, "webserver doesn't support hijacking", http.StatusInternalServerError)
			return
		}
		conn, bufrw, err := hj.Hijack()
		if err != nil {
			return
		}
		defer conn.Close()
		if err := bufrw.Flush(); err != nil {
			return
		}
		if _, err := conn.Write([]byte(`OK`)); err != nil {
			return
		}
		// Never read beyond HTTP's buffered prefix: its reader cancels the
		// request context on EOF, even after the connection has been hijacked.
		clientReader := io.MultiReader(io.LimitReader(bufrw.Reader, int64(bufrw.Reader.Buffered())), conn)
		relayTunnel(r.Context(), conn, guest, clientReader)
	}
}

func relayTunnel(ctx context.Context, client, guest net.Conn, clientReader io.Reader) {
	_ = tcprelay.Relay(ctx, &bufferedConn{Conn: client, reader: clientReader}, guest)
}

// serveControl makes instance cancellation reach hijacked tunnel handlers too.
func serveControl(ctx context.Context, listener net.Listener, handler http.Handler) error {
	server := &http.Server{Handler: handler, BaseContext: func(net.Listener) context.Context { return ctx }}
	return server.Serve(listener)
}
