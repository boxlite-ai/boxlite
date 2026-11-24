package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/miekg/dns"
)

const (
	proxyDNSLookupTimeout = 5 * time.Second
	dnsMessageMediaType   = "application/dns-message"
	dnsConcurrentLookups  = 64
)

var errDNSLookupCapacity = errors.New("external DNS lookup capacity reached")

// dnsLookupWork belongs to the bridge instance. All routes, including old
// snapshots with admitted work, share its limit and shutdown context.
type dnsLookupWork struct {
	instance context.Context
	slots    chan struct{}
	mu       sync.Mutex
	closing  bool
	active   sync.WaitGroup
}

func newDNSLookupWork(instance context.Context) *dnsLookupWork {
	return &dnsLookupWork{instance: instance, slots: make(chan struct{}, dnsConcurrentLookups)}
}

func (work *dnsLookupWork) begin(ctx context.Context) (context.Context, func(), error) {
	work.mu.Lock()
	defer work.mu.Unlock()
	if work.closing {
		return nil, nil, context.Canceled
	}
	select {
	case <-ctx.Done():
		return nil, nil, ctx.Err()
	case <-work.instance.Done():
		return nil, nil, work.instance.Err()
	default:
	}
	select {
	case work.slots <- struct{}{}:
		work.active.Add(1)
	default:
		return nil, nil, errDNSLookupCapacity
	}
	lookup, cancel := context.WithTimeout(ctx, proxyDNSLookupTimeout)
	stop := context.AfterFunc(work.instance, cancel)
	return lookup, func() {
		stop()
		cancel()
		<-work.slots
		work.active.Done()
	}, nil
}

func (work *dnsLookupWork) waitForShutdown() {
	work.mu.Lock()
	work.closing = true
	work.mu.Unlock()
	work.active.Wait()
}

// proxyDNSResolver is captured with the outbound route. Its socket destination
// is fixed independently of the HTTPS authority used for TLS verification.
type proxyDNSResolver struct {
	uri     string
	target  egressTarget
	roots   *x509.CertPool
	connect connectFunc
	work    *dnsLookupWork
	binding *managedProxyBinding
}

func newProxyDNSResolver(uri string, address netip.AddrPort, roots *x509.CertPool, connect connectFunc, work *dnsLookupWork) (*proxyDNSResolver, error) {
	endpoint, err := url.Parse(uri)
	if err != nil || endpoint.Scheme != "https" || endpoint.Hostname() == "" || endpoint.User != nil ||
		endpoint.Fragment != "" || endpoint.RawQuery != "" || endpoint.ForceQuery || !address.Addr().Unmap().Is4() || connect == nil || work == nil {
		return nil, errors.New("invalid pinned DNS resolver")
	}
	port := uint64(443)
	if endpoint.Port() != "" {
		port, err = strconv.ParseUint(endpoint.Port(), 10, 16)
	}
	if err != nil || port == 0 || uint16(port) != address.Port() {
		return nil, errors.New("pinned DNS resolver port does not match HTTPS URI")
	}
	if roots != nil {
		roots = roots.Clone()
	}
	ip := address.Addr().Unmap()
	return &proxyDNSResolver{
		uri: uri, roots: roots, connect: connect, work: work,
		target: egressTarget{Hostname: endpoint.Hostname(), PolicyIP: ip, ConnectionIP: ip, Port: address.Port()},
	}, nil
}

func (r *proxyDNSResolver) query(ctx context.Context, query *dns.Msg) (*dns.Msg, error) {
	ctx, release, err := r.work.begin(ctx)
	if err != nil {
		return nil, err
	}
	defer release()
	return r.exchange(ctx, query)
}

// The lookup owns tunnel setup, TLS, and closing the socket. HTTP Transport
// detaches its dial goroutine, so it receives only the already opened tunnel.
func (r *proxyDNSResolver) exchange(ctx context.Context, query *dns.Msg) (_ *dns.Msg, err error) {
	defer func() {
		if err == nil {
			return
		}
		if canceled := ctx.Err(); canceled != nil {
			err = canceled
			return
		}
		// The socket can reach its deadline before the lookup context reports it.
		deadline, bounded := ctx.Deadline()
		if errors.Is(err, proxyTimeout) ||
			(errors.Is(err, os.ErrDeadlineExceeded) && bounded && !time.Now().Before(deadline)) {
			err = context.DeadlineExceeded
		}
	}()
	if query.Response || query.Opcode != dns.OpcodeQuery || len(query.Question) != 1 {
		return nil, errors.New("DNS exchange requires one standard question")
	}
	wire, err := query.Pack()
	if err != nil || len(wire) > dns.MaxMsgSize {
		return nil, errors.New("invalid DNS wire query")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, r.uri, bytes.NewReader(wire))
	if err != nil {
		return nil, fmt.Errorf("build DNS HTTPS request: %w", err)
	}
	req.Header.Set("Content-Type", dnsMessageMediaType)
	req.Header.Set("Accept", dnsMessageMediaType)
	socket, err := r.connect(ctx, r.target)
	if err != nil {
		return nil, fmt.Errorf("open DNS proxy tunnel: %w", err)
	}
	// TLS, HTTP, and cancellation may all close the tunnel. The lookup joins
	// whichever caller initiated the underlying close before releasing its slot.
	conn := withJoinedClose(socket)
	defer conn.Close()
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	if deadline, ok := ctx.Deadline(); ok {
		if err := conn.SetDeadline(deadline); err != nil {
			return nil, err
		}
	}
	tlsConn := tls.Client(conn, &tls.Config{
		ServerName: r.target.Hostname, RootCAs: r.roots, MinVersion: tls.VersionTLS12,
		NextProtos: []string{"h2", "http/1.1"},
	})
	if err := tlsConn.HandshakeContext(ctx); err != nil {
		return nil, fmt.Errorf("DNS TLS handshake: %w", err)
	}
	var assigned atomic.Bool
	transport := &http.Transport{
		DialTLSContext: func(context.Context, string, string) (net.Conn, error) {
			if !assigned.CompareAndSwap(false, true) {
				return nil, errors.New("DNS proxy tunnel was already assigned")
			}
			return tlsConn, nil
		},
		ForceAttemptHTTP2:      true,
		DisableCompression:     true,
		DisableKeepAlives:      true,
		MaxResponseHeaderBytes: 64 << 10,
	}
	defer transport.CloseIdleConnections()
	response, err := transport.RoundTrip(req)
	if err != nil {
		return nil, fmt.Errorf("DNS HTTPS exchange: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("DNS HTTPS response status %d", response.StatusCode)
	}
	mediaType, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if err != nil || mediaType != dnsMessageMediaType {
		return nil, errors.New("invalid DNS HTTPS response media type")
	}
	return readProxyDNSReply(response.Body, query)
}

func readProxyDNSReply(body io.Reader, query *dns.Msg) (*dns.Msg, error) {
	// A sentinel byte detects oversize responses even when the HTTP peer
	// streams the body without a Content-Length.
	wire := make([]byte, dns.MaxMsgSize+1)
	length, err := io.ReadFull(body, wire)
	if length > dns.MaxMsgSize {
		return nil, errors.New("oversized DNS HTTPS response")
	}
	if err != io.ErrUnexpectedEOF && err != io.EOF {
		return nil, fmt.Errorf("read DNS HTTPS response: %w", err)
	}
	var reply dns.Msg
	if err := reply.Unpack(wire[:length]); err != nil {
		return nil, fmt.Errorf("decode DNS HTTPS response: %w", err)
	}
	if !reply.Response || reply.Opcode != query.Opcode || reply.Id != query.Id || len(reply.Question) != 1 {
		return nil, errors.New("DNS HTTPS response does not match request")
	}
	got, want := reply.Question[0], query.Question[0]
	if got.Qclass != want.Qclass || got.Qtype != want.Qtype || !strings.EqualFold(got.Name, want.Name) {
		return nil, errors.New("DNS HTTPS response question does not match request")
	}
	return &reply, nil
}

func (r *proxyDNSResolver) lookupIP(ctx context.Context, host string) ([]net.IP, error) {
	ctx, release, err := r.work.begin(ctx)
	if err != nil {
		return nil, err
	}
	defer release()
	name := dns.CanonicalName(host)
	var addresses []net.IP
	for _, recordType := range []uint16{dns.TypeA, dns.TypeAAAA} {
		resolved, err := r.lookupAddresses(ctx, name, recordType)
		if err != nil {
			return nil, err
		}
		addresses = append(addresses, resolved...)
	}
	return addresses, nil
}

func (r *proxyDNSResolver) lookupAddresses(ctx context.Context, name string, recordType uint16) ([]net.IP, error) {
	visited := map[string]bool{name: true}
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		reply, err := r.exchange(ctx, new(dns.Msg).SetQuestion(name, recordType))
		if err != nil {
			return nil, err
		}
		if reply.Rcode == dns.RcodeNameError {
			return nil, nil
		}
		if reply.Rcode != dns.RcodeSuccess || reply.Truncated {
			return nil, errors.New("DNS HTTPS resolver did not return a complete answer")
		}
		question := name
		for {
			addresses, alias, err := proxyDNSAddresses(reply.Answer, name, recordType)
			if err != nil || len(addresses) > 0 || (alias == "" && name == question) {
				return addresses, err
			}
			if alias == "" {
				break
			}
			if visited[alias] {
				return nil, errors.New("DNS HTTPS response contains a CNAME loop")
			}
			visited[alias] = true
			name = alias
		}
	}
}

func proxyDNSAddresses(answers []dns.RR, name string, recordType uint16) ([]net.IP, string, error) {
	var addresses []net.IP
	var alias string
	for _, answer := range answers {
		if answer.Header().Class != dns.ClassINET || dns.CanonicalName(answer.Header().Name) != name {
			continue
		}
		switch record := answer.(type) {
		case *dns.A:
			if recordType == dns.TypeA {
				addresses = append(addresses, record.A)
			}
		case *dns.AAAA:
			if recordType == dns.TypeAAAA {
				addresses = append(addresses, record.AAAA)
			}
		case *dns.CNAME:
			target := dns.CanonicalName(record.Target)
			if alias != "" && alias != target {
				return nil, "", errors.New("DNS HTTPS response contains conflicting aliases")
			}
			alias = target
		}
	}
	if alias != "" && len(addresses) > 0 {
		return nil, "", errors.New("DNS HTTPS answer contains addresses and an alias for the same name")
	}
	return addresses, alias, nil
}
