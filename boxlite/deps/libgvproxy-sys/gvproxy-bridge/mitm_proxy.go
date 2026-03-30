package main

import (
	"bufio"
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"time"

	logrus "github.com/sirupsen/logrus"
	"golang.org/x/net/http2"
)

const upstreamDialTimeout = 30 * time.Second

// mitmAndForward handles a MITM'd connection: TLS termination, reverse proxy, secret substitution.
// upstreamTLSConfig overrides the TLS config for upstream connections (nil = system defaults).
func mitmAndForward(guestConn net.Conn, hostname string, destAddr string, ca *BoxCA, secrets []SecretConfig, upstreamTLSConfig ...*tls.Config) {
	cert, err := ca.GenerateHostCert(hostname)
	if err != nil {
		logrus.WithError(err).WithField("hostname", hostname).Error("MITM: cert generation failed")
		guestConn.Close()
		return
	}

	tlsGuest := tls.Server(guestConn, &tls.Config{
		GetCertificate: func(*tls.ClientHelloInfo) (*tls.Certificate, error) {
			return cert, nil
		},
		NextProtos: []string{"h2", "http/1.1"},
	})

	upstreamTransport := &http.Transport{
		ForceAttemptHTTP2: true,
		TLSClientConfig:  resolveUpstreamTLS(hostname, upstreamTLSConfig...),
		DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{Timeout: upstreamDialTimeout}).DialContext(ctx, network, destAddr)
		},
	}

	proxy := &httputil.ReverseProxy{
		Director: func(req *http.Request) {
			req.URL.Scheme = "https"
			req.URL.Host = hostname
			req.Host = hostname // HTTP/1.1 Host header must match
			// Headers substituted here; body substituted in secretTransport.RoundTrip
			substituteHeaders(req, secrets)
		},
		Transport: &secretTransport{
			inner:   upstreamTransport,
			secrets: secrets,
		},
		FlushInterval: -1,
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			logrus.WithFields(logrus.Fields{
				"hostname": hostname,
				"path":     r.URL.Path,
				"error":    err,
			}).Warn("MITM: upstream error")
			w.WriteHeader(http.StatusBadGateway)
		},
	}

	if err := tlsGuest.Handshake(); err != nil {
		logrus.WithError(err).WithField("hostname", hostname).Debug("MITM: TLS handshake failed")
		guestConn.Close()
		return
	}

	if tlsGuest.ConnectionState().NegotiatedProtocol == "h2" {
		h2srv := &http2.Server{}
		h2srv.ServeConn(tlsGuest, &http2.ServeConnOpts{Handler: proxy})
	} else {
		// HTTP/1.1: serve directly on the connection (no http.Server).
		// Using http.Server + singleConnListener leaks a goroutine in Accept()
		// after the connection closes. Serving directly avoids this.
		serveHTTP1(tlsGuest, proxy)
	}
}

// serveHTTP1 handles HTTP/1.1 requests on a single TLS connection.
// Supports keep-alive: reads requests in a loop until the client closes.
func serveHTTP1(conn net.Conn, handler http.Handler) {
	defer conn.Close()
	br := bufio.NewReaderSize(conn, 4096)

	for {
		req, err := http.ReadRequest(br)
		if err != nil {
			return // client closed or malformed — done
		}

		rw := newResponseWriter(conn)
		handler.ServeHTTP(rw, req)
		rw.finish()
		req.Body.Close()

		if req.Close || rw.closeAfter {
			return
		}
	}
}

// responseWriter implements http.ResponseWriter for a raw net.Conn.
type responseWriter struct {
	conn       net.Conn
	header     http.Header
	wroteHead  bool
	status     int
	closeAfter bool
}

func newResponseWriter(conn net.Conn) *responseWriter {
	return &responseWriter{conn: conn, header: http.Header{}, status: 200}
}

func (w *responseWriter) Header() http.Header { return w.header }

func (w *responseWriter) WriteHeader(code int) {
	if w.wroteHead {
		return
	}
	w.wroteHead = true
	w.status = code

	// Write status line + headers
	fmt.Fprintf(w.conn, "HTTP/1.1 %d %s\r\n", code, http.StatusText(code))
	w.header.Write(w.conn)
	fmt.Fprint(w.conn, "\r\n")
}

func (w *responseWriter) Write(b []byte) (int, error) {
	if !w.wroteHead {
		w.WriteHeader(200)
	}
	return w.conn.Write(b)
}

func (w *responseWriter) finish() {
	if !w.wroteHead {
		w.WriteHeader(200)
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

