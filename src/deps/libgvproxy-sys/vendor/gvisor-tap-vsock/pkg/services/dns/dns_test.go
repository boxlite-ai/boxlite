package dns

import (
	"context"
	"net"
	"testing"
	"time"

	"github.com/containers/gvisor-tap-vsock/pkg/types"
	"github.com/miekg/dns"
	"github.com/onsi/ginkgo"
	"github.com/onsi/gomega"
	log "github.com/sirupsen/logrus"
	"github.com/stretchr/testify/require"
)

func TestSuite(t *testing.T) {
	gomega.RegisterFailHandler(ginkgo.Fail)
	ginkgo.RunSpecs(t, "gvisor-tap-vsock dns suit")
}

var _ = ginkgo.Describe("dns add test", func() {
	var server *Server

	ginkgo.BeforeEach(func() {
		server, _ = New(nil, nil, []types.Zone{})
	})

	ginkgo.It("should add dns zone with ip", func() {
		req := types.Zone{
			Name:      "internal.",
			DefaultIP: net.ParseIP("192.168.0.1"),
		}
		server.addZone(req)

		gomega.Expect(server.handler.zones).To(gomega.Equal([]types.Zone{req}))
	})

	ginkgo.It("should add dns zone with record", func() {
		req := types.Zone{
			Name: "internal.",
			Records: []types.Record{{
				Name: "crc.testiing",
				IP:   net.ParseIP("192.168.0.2"),
			}},
		}
		server.addZone(req)

		gomega.Expect(server.handler.zones).To(gomega.Equal([]types.Zone{req}))
	})

	ginkgo.It("should add dns zone with record and ip", func() {
		ipReq := types.Zone{
			Name:      "dynamic.internal.",
			DefaultIP: net.ParseIP("192.168.0.1"),
		}
		recordReq := types.Zone{
			Name: "internal.",
			Records: []types.Record{{
				Name: "crc.testiing",
				IP:   net.ParseIP("192.168.0.2"),
			}},
		}
		server.addZone(ipReq)
		server.addZone(recordReq)

		gomega.Expect(server.handler.zones).To(gomega.Equal([]types.Zone{ipReq, recordReq}))
	})

	ginkgo.It("should add new zone to existing zone with default ip", func() {
		ipReq := types.Zone{
			Name:      "internal.",
			DefaultIP: net.ParseIP("192.168.0.1"),
		}
		server.addZone(ipReq)
		recordReq := types.Zone{
			Name: "internal.",
			Records: []types.Record{{
				Name: "crc.testing",
				IP:   net.ParseIP("192.168.0.2"),
			}},
		}
		server.addZone(recordReq)

		gomega.Expect(server.handler.zones).To(gomega.Equal([]types.Zone{{
			Name: "internal.",
			Records: []types.Record{{
				Name: "crc.testing",
				IP:   net.ParseIP("192.168.0.2"),
			}},
		}}))
	})

	ginkgo.It("should add new zone to existing zone with records", func() {
		ipReq := types.Zone{
			Name: "internal.",
			Records: []types.Record{{
				Name: "crc.testing",
				IP:   net.ParseIP("192.168.0.2"),
			}},
		}
		server.addZone(ipReq)
		recordReq := types.Zone{
			Name: "internal.",
			Records: []types.Record{{
				Name: "crc.testing",
				IP:   net.ParseIP("192.168.0.3"),
			}},
		}
		server.addZone(recordReq)

		gomega.Expect(server.handler.zones).To(gomega.Equal([]types.Zone{{
			Name: "internal.",
			Records: []types.Record{{
				Name: "crc.testing",
				IP:   net.ParseIP("192.168.0.3"),
			}, {
				Name: "crc.testing",
				IP:   net.ParseIP("192.168.0.2"),
			}},
		}}))
	})

	ginkgo.It("should add new zone to existing zone with records", func() {
		ipReq := types.Zone{
			Name: "internal.",
			Records: []types.Record{{
				Name: "crc.testing",
				IP:   net.ParseIP("192.168.0.2"),
			}},
		}
		server.addZone(ipReq)
		recordReq := types.Zone{
			Name: "internal.",
			Records: []types.Record{{
				Name: "crc.testing",
				IP:   net.ParseIP("192.168.0.3"),
			}},
		}
		server.addZone(recordReq)

		gomega.Expect(server.handler.zones).To(gomega.Equal([]types.Zone{{
			Name: "internal.",
			Records: []types.Record{{
				Name: "crc.testing",
				IP:   net.ParseIP("192.168.0.3"),
			}, {
				Name: "crc.testing",
				IP:   net.ParseIP("192.168.0.2"),
			}},
		}}))
	})

	ginkgo.It("should retain the order of zones", func() {
		server, _ = New(nil, nil, []types.Zone{
			{
				Name:      "crc.testing.",
				DefaultIP: net.ParseIP("192.168.127.2"),
			},
			{
				Name: "testing.",
				Records: []types.Record{
					{
						Name: "host",
						IP:   net.ParseIP("192.168.127.3"),
					},
				},
			},
		})
		server.addZone(types.Zone{
			Name: "testing.",
			Records: []types.Record{
				{
					Name: "gateway",
					IP:   net.ParseIP("192.168.127.1"),
				},
			},
		})
		gomega.Expect(server.handler.zones).To(gomega.Equal([]types.Zone{
			{
				Name:      "crc.testing.",
				DefaultIP: net.ParseIP("192.168.127.2"),
			},
			{
				Name: "testing.",
				Records: []types.Record{
					{
						Name: "gateway",
						IP:   net.ParseIP("192.168.127.1"),
					},
					{
						Name: "host",
						IP:   net.ParseIP("192.168.127.3"),
					},
				},
			},
		}))
	})

	ginkgo.It("Should pass DNS requests to default system DNS server", func() {
		m := &dns.Msg{
			MsgHdr: dns.MsgHdr{
				Authoritative:     false,
				AuthenticatedData: false,
				CheckingDisabled:  false,
				RecursionDesired:  true,
				Opcode:            0,
			},
			Question: make([]dns.Question, 1),
		}

		m.Question[0] = dns.Question{
			Name:   "redhat.com.",
			Qtype:  1,
			Qclass: 1,
		}

		server.handler.addAnswers(m)

		gomega.Expect(m.Answer[0].Header().Name).To(gomega.Equal("redhat.com."))
		gomega.Expect(m.Answer[0].String()).To(gomega.SatisfyAny(gomega.ContainSubstring("34.235.198.240"), gomega.ContainSubstring("52.200.142.250")))
	})
})

type ARecord struct {
	name        string
	expectedIPs []string
}

func TestDNS(t *testing.T) {
	log.Infof("starting test DNS servers")
	nameserver, cleanup, err := startDNSServer()
	require.NoError(t, err)
	defer cleanup()
	time.Sleep(100 * time.Millisecond)
	log.Infof("test DNS servers started")

	r := &net.Resolver{
		PreferGo: true,
		Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			d := net.Dialer{
				Timeout: time.Millisecond * time.Duration(10000),
			}
			log.Infof("dialing %s %s", network, nameserver)

			return d.DialContext(ctx, network, nameserver)
		},
	}
	redhatdotcom := ARecord{
		name:        "redhat.com",
		expectedIPs: []string{"52.200.142.250"},
	}
	record := redhatdotcom
	{
		log.Infof("looking up %s", record.name)
		ipGvisor, err := r.LookupHost(context.Background(), record.name)
		require.NoError(t, err)
		require.Subset(t, ipGvisor, record.expectedIPs)
		log.Infof("ip gvisor: %+v", ipGvisor)

		ipGo, err := net.LookupHost(record.name)
		require.NoError(t, err)
		log.Infof("ip go: %+v", ipGo)
		require.Subset(t, ipGvisor, ipGo)
	}
}

func startDNSServer() (string, func(), error) {
	udpConn, err := net.ListenPacket("udp", "127.0.0.1:5354")
	if err != nil {
		return "", nil, err
	}

	tcpLn, err := net.Listen("tcp", "127.0.0.1:5354")
	if err != nil {
		return "", nil, err
	}

	server, err := New(udpConn, tcpLn, nil)
	if err != nil {
		return "", nil, err
	}

	go func() {
		if err := server.Serve(); err != nil {
			log.Errorf("serve UDP error: %T %s", err, err)
		}
	}()
	go func() {
		if err := server.ServeTCP(); err != nil {
			log.Errorf("serve TCP error: %T %s", err, err)
		}
	}()
	return "127.0.0.1:5354", func() {
		udpConn.Close()
		tcpLn.Close()
	}, nil
}
