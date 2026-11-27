package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/textproto"
	"strconv"
	"strings"
	"time"

	logrus "github.com/sirupsen/logrus"
	"gvisor.dev/gvisor/pkg/tcpip/transport/tcp"
)

const tcpInspectionBytes = 16 << 10

func forwardExtendedTCP(r *tcp.ForwarderRequest, target egressTarget, snapshot *outboundSnapshot,
	slots chan struct{}, ca *BoxCA, secrets *SecretHostMatcher) {
	ctx, cancel := context.WithTimeout(context.Background(), upstreamDialTimeout)
	defer cancel()
	address := snapshot.egressAddressFacts(target.PolicyIP, false)
	names := outboundNameFacts{inspectionPending: true, secretsPossible: secrets != nil && target.Port == 443}
	decision := snapshot.extended.evaluate(target, address, names)
	if decision.reason != outboundAllowed && decision.reason != outboundInspectName {
		logrus.WithField("reason", decision.reason).Debug("extended TCP denied")
		r.Complete(true)
		return
	}
	guest := openGuestTCP(r)
	if guest == nil {
		return
	}
	defer guest.Close()
	if ctx.Err() != nil {
		return
	}
	if decision.reason == outboundInspectName {
		select {
		case slots <- struct{}{}:
		default:
			return
		}
		deadline, _ := ctx.Deadline()
		err := guest.SetReadDeadline(deadline)
		var tlsName bool
		if err == nil {
			guest, target.Hostname, tlsName = inspectExtendedTCP(guest)
		}
		<-slots
		if err != nil || ctx.Err() != nil {
			return
		}
		if err := guest.SetReadDeadline(time.Time{}); err != nil {
			return
		}
		names = outboundNameFacts{secretsMatch: tlsName && names.secretsPossible && secrets.Matches(target.Hostname)}
		decision = snapshot.extended.evaluate(target, address, names)
	}

	dialer := snapshot.dialer
	if (decision.checkAssociation || decision.route == outboundAddressRoute) &&
		snapshot.egressAddressFacts(target.ConnectionIP, false).platformDenied {
		logrus.WithField("reason", outboundPlatformDeny).Debug("extended TCP translated address denied")
		return
	}
	if decision.checkAssociation {
		names.associatedAddress = dialer.associateAddress(ctx, target)
		decision = snapshot.extended.evaluate(target, address, names)
	}
	if decision.reason != outboundAllowed {
		logrus.WithField("reason", decision.reason).Debug("extended TCP denied")
		return
	}

	dial := func(ctx context.Context) (net.Conn, error) {
		return dialer.dialHost(ctx, target, func(candidate netip.Addr) outboundReason {
			return snapshot.extended.checkCandidate(snapshot.egressAddressFacts(candidate, true), target.Port)
		})
	}
	switch decision.route {
	case outboundAddressRoute:
		dial = dialer.byAddress(target)
	case outboundSecretsRoute:
		mitmForward(guest, target.Hostname, dial, ca, secrets.SecretsForHost(target.Hostname), ctx)
		return
	}
	if upstream, err := dial(ctx); err == nil {
		cancel()
		relayTCP(guest, upstream)
	}
}

func (d *egressDialer) associateAddress(ctx context.Context, target egressTarget) netip.Addr {
	resolved, err := d.lookup(ctx, target.Hostname)
	if err == nil {
		for _, ip := range resolved {
			if address, ok := netip.AddrFromSlice(ip); ok && address.Unmap() == target.ConnectionIP {
				return target.ConnectionIP
			}
		}
	}
	return netip.Addr{}
}

// Retain parser read-ahead so the admitted connection sees the original stream.
func inspectExtendedTCP(guest net.Conn) (net.Conn, string, bool) {
	var captured bytes.Buffer
	reader := bufio.NewReader(io.TeeReader(io.LimitReader(guest, tcpInspectionBytes), &captured))
	prefix, err := reader.Peek(1)
	var name string
	isTLS := err == nil && prefix[0] == 0x16
	if isTLS {
		parser := tls.Server(sniSniffConn{r: reader}, &tls.Config{
			GetConfigForClient: func(hello *tls.ClientHelloInfo) (*tls.Config, error) {
				for _, extension := range hello.Extensions {
					if extension == 0xfe0d { // RFC 9849 encrypted_client_hello
						return nil, io.EOF
					}
				}
				name = outboundObservedName(hello.ServerName)
				return nil, io.EOF
			},
		})
		_ = parser.Handshake()
	} else if err == nil {
		name = inspectHTTPAuthority(reader, &captured)
	}
	replay := io.MultiReader(bytes.NewReader(captured.Bytes()), guest)
	return &bufferedConn{Conn: guest, reader: replay}, name, isTLS
}

func inspectHTTPAuthority(reader *bufio.Reader, captured *bytes.Buffer) string {
	request, err := http.ReadRequest(reader)
	if err != nil || request.ProtoMajor != 1 || request.URL.User != nil {
		return ""
	}
	wire := textproto.NewReader(bufio.NewReader(bytes.NewReader(captured.Bytes())))
	if _, err := wire.ReadLine(); err != nil {
		return ""
	}
	headers, err := wire.ReadMIMEHeader()
	hosts := headers.Values("Host")
	if err != nil || len(hosts) != 1 || (request.URL.Host != "" && !strings.EqualFold(request.URL.Host, hosts[0])) {
		return ""
	}
	host := hosts[0]
	if strings.Contains(host, ":") {
		hostname, port, err := net.SplitHostPort(host)
		if err != nil || !outboundDecimal(port) {
			return ""
		}
		if number, err := strconv.ParseUint(port, 10, 16); err != nil || number == 0 {
			return ""
		}
		host = hostname
	}
	return outboundObservedName(host)
}
