package dns

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"strings"
	"sync"

	"github.com/containers/gvisor-tap-vsock/pkg/types"
	"github.com/miekg/dns"
	log "github.com/sirupsen/logrus"
)

type dnsHandler struct {
	zones     []types.Zone
	zonesLock sync.RWMutex
}

func (h *dnsHandler) handle(w dns.ResponseWriter, r *dns.Msg, responseMessageSize int) {
	m := new(dns.Msg)
	m.SetReply(r)
	m.RecursionAvailable = true
	h.addAnswers(m)
	edns0 := r.IsEdns0()
	if edns0 != nil {
		responseMessageSize = int(edns0.UDPSize())
	}
	m.Truncate(responseMessageSize)
	if err := w.WriteMsg(m); err != nil {
		log.Error(err)
	}
}

func (h *dnsHandler) handleTCP(w dns.ResponseWriter, r *dns.Msg) {
	h.handle(w, r, dns.MaxMsgSize)
}

func (h *dnsHandler) handleUDP(w dns.ResponseWriter, r *dns.Msg) {
	h.handle(w, r, dns.MinMsgSize)
}

func (h *dnsHandler) addLocalAnswers(m *dns.Msg, q dns.Question) bool {
	h.zonesLock.RLock()
	defer h.zonesLock.RUnlock()

	for _, zone := range h.zones {
		zoneSuffix := fmt.Sprintf(".%s", zone.Name)
		if strings.HasSuffix(q.Name, zoneSuffix) {
			if q.Qtype != dns.TypeA {
				return false
			}
			for _, record := range zone.Records {
				withoutZone := strings.TrimSuffix(q.Name, zoneSuffix)
				if (record.Name != "" && record.Name == withoutZone) ||
					(record.Regexp != nil && record.Regexp.MatchString(withoutZone)) {
					m.Answer = append(m.Answer, &dns.A{
						Hdr: dns.RR_Header{
							Name:   q.Name,
							Rrtype: dns.TypeA,
							Class:  dns.ClassINET,
							Ttl:    0,
						},
						A: record.IP,
					})
					return true
				}
			}
			if !zone.DefaultIP.Equal(net.IP("")) {
				m.Answer = append(m.Answer, &dns.A{
					Hdr: dns.RR_Header{
						Name:   q.Name,
						Rrtype: dns.TypeA,
						Class:  dns.ClassINET,
						Ttl:    0,
					},
					A: zone.DefaultIP,
				})
				return true
			}
			m.Rcode = dns.RcodeNameError
			return true
		}
	}
	return false
}

func (h *dnsHandler) addAnswers(m *dns.Msg) {
	for _, q := range m.Question {
		if done := h.addLocalAnswers(m, q); done {
			return
		}

		resolver := net.Resolver{
			PreferGo: false,
		}
		switch q.Qtype {
		case dns.TypeA:
			ips, err := resolver.LookupIPAddr(context.TODO(), q.Name)
			if err != nil {
				m.Rcode = dns.RcodeNameError
				return
			}
			for _, ip := range ips {
				if len(ip.IP.To4()) != net.IPv4len {
					continue
				}
				m.Answer = append(m.Answer, &dns.A{
					Hdr: dns.RR_Header{
						Name:   q.Name,
						Rrtype: dns.TypeA,
						Class:  dns.ClassINET,
						Ttl:    0,
					},
					A: ip.IP.To4(),
				})
			}
		case dns.TypeCNAME:
			cname, err := resolver.LookupCNAME(context.TODO(), q.Name)
			if err != nil {
				m.Rcode = dns.RcodeNameError
				return
			}
			m.Answer = append(m.Answer, &dns.CNAME{
				Hdr: dns.RR_Header{
					Name:   q.Name,
					Rrtype: dns.TypeCNAME,
					Class:  dns.ClassINET,
					Ttl:    0,
				},
				Target: cname,
			})
		case dns.TypeMX:
			records, err := resolver.LookupMX(context.TODO(), q.Name)
			if err != nil {
				m.Rcode = dns.RcodeNameError
				return
			}
			for _, mx := range records {
				m.Answer = append(m.Answer, &dns.MX{
					Hdr: dns.RR_Header{
						Name:   q.Name,
						Rrtype: dns.TypeMX,
						Class:  dns.ClassINET,
						Ttl:    0,
					},
					Mx:         mx.Host,
					Preference: mx.Pref,
				})
			}
		case dns.TypeNS:
			records, err := resolver.LookupNS(context.TODO(), q.Name)
			if err != nil {
				m.Rcode = dns.RcodeNameError
				return
			}
			for _, ns := range records {
				m.Answer = append(m.Answer, &dns.NS{
					Hdr: dns.RR_Header{
						Name:   q.Name,
						Rrtype: dns.TypeNS,
						Class:  dns.ClassINET,
						Ttl:    0,
					},
					Ns: ns.Host,
				})
			}
		case dns.TypeSRV:
			_, records, err := resolver.LookupSRV(context.TODO(), "", "", q.Name)
			if err != nil {
				m.Rcode = dns.RcodeNameError
				return
			}
			for _, srv := range records {
				m.Answer = append(m.Answer, &dns.SRV{
					Hdr: dns.RR_Header{
						Name:   q.Name,
						Rrtype: dns.TypeSRV,
						Class:  dns.ClassINET,
						Ttl:    0,
					},
					Port:     srv.Port,
					Priority: srv.Priority,
					Target:   srv.Target,
					Weight:   srv.Weight,
				})
			}
		case dns.TypeTXT:
			records, err := resolver.LookupTXT(context.TODO(), q.Name)
			if err != nil {
				m.Rcode = dns.RcodeNameError
				return
			}
			m.Answer = append(m.Answer, &dns.TXT{
				Hdr: dns.RR_Header{
					Name:   q.Name,
					Rrtype: dns.TypeTXT,
					Class:  dns.ClassINET,
					Ttl:    0,
				},
				Txt: records,
			})
		}
	}
}

type Server struct {
	udpConn net.PacketConn
	tcpLn   net.Listener
	handler *dnsHandler
}

func New(udpConn net.PacketConn, tcpLn net.Listener, zones []types.Zone) (*Server, error) {
	handler := &dnsHandler{zones: zones}
	return &Server{udpConn: udpConn, tcpLn: tcpLn, handler: handler}, nil
}

func (s *Server) Serve() error {
	mux := dns.NewServeMux()
	mux.HandleFunc(".", s.handler.handleUDP)
	srv := &dns.Server{
		PacketConn: s.udpConn,
		Handler:    mux,
	}
	return srv.ActivateAndServe()
}

func (s *Server) ServeTCP() error {
	mux := dns.NewServeMux()
	mux.HandleFunc(".", s.handler.handleTCP)
	tcpSrv := &dns.Server{
		Listener: s.tcpLn,
		Handler:  mux,
	}
	return tcpSrv.ActivateAndServe()
}

func (s *Server) Mux() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/all", func(w http.ResponseWriter, _ *http.Request) {
		s.handler.zonesLock.RLock()
		_ = json.NewEncoder(w).Encode(s.handler.zones)
		s.handler.zonesLock.RUnlock()
	})

	mux.HandleFunc("/add", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "post only", http.StatusBadRequest)
			return
		}
		var req types.Zone
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		s.addZone(req)
		w.WriteHeader(http.StatusOK)
	})
	return mux
}

func (s *Server) addZone(req types.Zone) {
	s.handler.zonesLock.Lock()
	defer s.handler.zonesLock.Unlock()
	for i, zone := range s.handler.zones {
		if zone.Name == req.Name {
			req.Records = append(req.Records, zone.Records...)
			s.handler.zones[i] = req
			return
		}
	}
	// No existing zone for req.Name, add new one
	s.handler.zones = append(s.handler.zones, req)
}
