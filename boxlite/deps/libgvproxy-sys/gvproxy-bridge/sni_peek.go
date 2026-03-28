package main

// sni_peek.go — Extract SNI/Host from TCP connections without consuming bytes.
//
// Uses bufio.Reader.Peek() so the connection can be forwarded after inspection.
// SNI extraction uses the crypto/tls.Server + GetConfigForClient technique from
// inet.af/tcpproxy (Apache 2.0, already a gvproxy dependency).

import (
	"bufio"
	"bytes"
	"crypto/tls"
	"io"
	"net"
	"net/http"
	"strings"
)

// peekClientHelloSNI extracts the SNI hostname from a TLS ClientHello
// without consuming any bytes from br.
// Returns "" if not TLS, no SNI present, or on any parse error.
func peekClientHelloSNI(br *bufio.Reader) string {
	const recordHeaderLen = 5
	hdr, err := br.Peek(recordHeaderLen)
	if err != nil {
		return ""
	}
	// TLS handshake record type = 0x16
	if hdr[0] != 0x16 {
		return ""
	}
	recLen := int(hdr[3])<<8 | int(hdr[4])
	if recLen == 0 || recLen > 16384 {
		return ""
	}

	// Peek the full ClientHello record
	helloBytes, err := br.Peek(recordHeaderLen + recLen)
	if err != nil {
		return ""
	}

	// Use crypto/tls to parse — GetConfigForClient fires with the SNI
	var sni string
	tls.Server(sniSniffConn{r: bytes.NewReader(helloBytes)}, &tls.Config{
		GetConfigForClient: func(hello *tls.ClientHelloInfo) (*tls.Config, error) {
			sni = hello.ServerName
			return nil, nil
		},
	}).Handshake() //nolint:errcheck // Handshake fails intentionally; we only want SNI

	return sni
}

// peekHTTPHost extracts the Host header from an HTTP/1.x request
// without consuming any bytes from br.
// Returns "" if not HTTP or no Host header found.
func peekHTTPHost(br *bufio.Reader) string {
	const maxPeek = 4096
	for peekSize := 1; peekSize <= maxPeek; peekSize++ {
		b, err := br.Peek(peekSize)
		// Use actual buffered amount if larger
		if n := br.Buffered(); n > peekSize {
			b, _ = br.Peek(n)
			peekSize = n
		}
		if len(b) > 0 {
			// HTTP methods start with uppercase letter
			if b[0] < 'A' || b[0] > 'Z' {
				return ""
			}
			// Found end of headers?
			if bytes.Contains(b, []byte("\r\n\r\n")) || bytes.Contains(b, []byte("\n\n")) {
				req, err := http.ReadRequest(bufio.NewReader(bytes.NewReader(b)))
				if err != nil {
					return ""
				}
				host := req.Host
				if h, _, err := net.SplitHostPort(host); err == nil {
					host = h
				}
				return strings.ToLower(host)
			}
		}
		if err != nil {
			return extractHostFallback(b)
		}
	}
	return ""
}

// extractHostFallback does a best-effort Host header extraction from partial data.
func extractHostFallback(b []byte) string {
	for _, prefix := range [][]byte{[]byte("\nHost:"), []byte("\nhost:")} {
		if i := bytes.Index(b, prefix); i != -1 {
			rest := b[i+len(prefix):]
			if j := bytes.IndexByte(rest, '\n'); j != -1 {
				rest = rest[:j]
			}
			host := strings.TrimSpace(string(rest))
			if h, _, err := net.SplitHostPort(host); err == nil {
				return strings.ToLower(h)
			}
			return strings.ToLower(host)
		}
	}
	return ""
}

// sniSniffConn is a net.Conn that only supports Read (from r).
// Used with tls.Server to extract ClientHello without a real connection.
type sniSniffConn struct {
	r        io.Reader
	net.Conn // nil; crashes on any unexpected use
}

func (c sniSniffConn) Read(p []byte) (int, error) { return c.r.Read(p) }
func (sniSniffConn) Write(p []byte) (int, error)  { return 0, io.EOF }
