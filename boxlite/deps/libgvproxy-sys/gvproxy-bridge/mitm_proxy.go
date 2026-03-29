package main

import (
	"context"
	"crypto/tls"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"sync"

	logrus "github.com/sirupsen/logrus"
	"golang.org/x/net/http2"
)

// mitmAndForward handles a MITM'd connection: TLS termination, reverse proxy, secret substitution.
func mitmAndForward(guestConn net.Conn, hostname string, destAddr string, ca *BoxCA, secrets []SecretConfig) {
	logrus.WithFields(logrus.Fields{"hostname": hostname, "destAddr": destAddr, "secrets": len(secrets)}).Info("MITM: mitmAndForward called")
	cert, err := ca.GenerateHostCert(hostname)
	if err != nil {
		log.Printf("mitm: failed to generate cert for %s: %v", hostname, err)
		guestConn.Close()
		return
	}

	tlsConfig := &tls.Config{
		GetCertificate: func(hello *tls.ClientHelloInfo) (*tls.Certificate, error) {
			return cert, nil
		},
		NextProtos: []string{"h2", "http/1.1"},
	}

	tlsGuest := tls.Server(guestConn, tlsConfig)

	// Transport for connecting to the real upstream.
	// Use hostname for both dial and TLS (not the raw dest IP) so the connection
	// goes through system DNS and proxy if configured. This is correct because
	// the MITM proxy acts as a forward proxy — it should connect to the upstream
	// the same way any host process would.
	log.Printf("[MITM] upstream: hostname=%s destAddr=%s", hostname, destAddr)
	upstreamTransport := &http.Transport{
		ForceAttemptHTTP2: true,
		TLSClientConfig: &tls.Config{
			ServerName:         hostname,
			InsecureSkipVerify: true,
		},
		// Route to the original dest IP from the gVisor stack.
		// This is the same approach as standardForward (net.Dial to destAddr).
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, network, destAddr)
		},
	}

	proxy := &httputil.ReverseProxy{
		Director: func(req *http.Request) {
			req.URL.Scheme = "https"
			req.URL.Host = hostname
			substituteHeaders(req, secrets)
		},
		Transport: &secretTransport{
			inner:   upstreamTransport,
			secrets: secrets,
		},
		FlushInterval: -1, // stream immediately
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			log.Printf("ERROR hostname=%s path=%s destAddr=%s err=%v", hostname, r.URL.Path, destAddr, err)
			w.WriteHeader(http.StatusBadGateway)
		},
	}

	// Do TLS handshake explicitly to determine negotiated protocol
	if err := tlsGuest.Handshake(); err != nil {
		log.Printf("mitm: TLS handshake failed: %v", err)
		guestConn.Close()
		return
	}

	negotiated := tlsGuest.ConnectionState().NegotiatedProtocol

	if negotiated == "h2" {
		// Serve HTTP/2 directly on the connection
		h2srv := &http2.Server{}
		h2srv.ServeConn(tlsGuest, &http2.ServeConnOpts{
			Handler: proxy,
		})
	} else {
		// Serve HTTP/1.1 via http.Server
		listener := newSingleConnListener(tlsGuest)
		srv := &http.Server{
			Handler: proxy,
		}
		srv.Serve(listener)
	}
}

// secretTransport wraps http.RoundTripper to inject streaming body replacement.
type secretTransport struct {
	inner   http.RoundTripper
	secrets []SecretConfig
}

func (t *secretTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.Body != nil && len(t.secrets) > 0 {
		req.Body = newStreamingReplacer(req.Body, t.secrets)
		req.ContentLength = -1
		req.Header.Del("Content-Length")
	}
	return t.inner.RoundTrip(req)
}

// singleConnListener wraps a single net.Conn as a net.Listener.
type singleConnListener struct {
	conn   net.Conn
	ch     chan net.Conn
	once   sync.Once
	closed chan struct{}
}

func newSingleConnListener(conn net.Conn) *singleConnListener {
	l := &singleConnListener{
		conn:   conn,
		ch:     make(chan net.Conn, 1),
		closed: make(chan struct{}),
	}
	l.ch <- conn
	return l
}

func (l *singleConnListener) Accept() (net.Conn, error) {
	select {
	case conn := <-l.ch:
		return conn, nil
	case <-l.closed:
		return nil, net.ErrClosed
	}
}

func (l *singleConnListener) Close() error {
	l.once.Do(func() {
		close(l.closed)
	})
	return nil
}

func (l *singleConnListener) Addr() net.Addr {
	return l.conn.LocalAddr()
}
