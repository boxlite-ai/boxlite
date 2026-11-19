package main

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"strings"
	"sync"

	"github.com/containers/gvisor-tap-vsock/pkg/types"
	"github.com/miekg/dns"
)

type gatewayDNS struct {
	snapshot snapshotSource
	work     *dnsLookupWork
	resolver hostDNSResolver
	server   *gatewayDNSServer
	zonesMu  sync.RWMutex
	zones    []types.Zone
}

func (p *outboundPolicyController) installGatewayDNS(ctx context.Context, work *dnsLookupWork) (*gatewayDNS, error) {
	service := &gatewayDNS{
		snapshot: p.active.Load, work: work, resolver: hostResolver,
		zones: append([]types.Zone(nil), p.config.DNS...),
	}
	server, err := replaceGatewayDNS(ctx, p.stack, p.nic, net.ParseIP(p.config.GatewayIP), service.answer)
	if err != nil {
		return nil, err
	}
	service.server = server
	// Install before Guest attachment and control requests. Subsequent
	// snapshots reuse the same instance-owned lookup capacity.
	p.dnsWork = work
	snapshot := *p.active.Load()
	snapshot.configureResolution(work)
	p.publish(&snapshot, snapshot.state)
	return service, nil
}

func (g *gatewayDNS) answer(ctx context.Context, query *dns.Msg) *dns.Msg {
	// An established TCP session or a queued datagram can outlive the
	// snapshot that admitted its packets. Admit each DNS message here.
	snapshot := g.snapshot()
	if snapshot.ingressClosed() {
		return nil
	}
	reply := new(dns.Msg).SetReply(query)
	reply.RecursionAvailable = true
	if query.Response || query.Opcode != dns.OpcodeQuery || len(query.Question) != 1 {
		reply.Rcode = dns.RcodeFormatError
		return reply
	}
	question := query.Question[0]
	if g.localAnswer(reply, question, snapshot.proxyDNS != nil) {
		return reply
	}
	if snapshot.state != "confirmed" {
		reply.Rcode = dns.RcodeServerFailure
		return reply
	}
	if snapshot.proxyDNS != nil {
		answer, err := snapshot.proxyDNS.query(ctx, query)
		if err != nil {
			reply.Rcode = dns.RcodeServerFailure
			return reply
		}
		return answer
	}
	lookup, done, err := g.work.begin(ctx)
	if err != nil {
		reply.Rcode = dns.RcodeServerFailure
		return reply
	}
	defer done()
	reply.Answer, err = systemDNSAnswer(lookup, g.resolver, question)
	if err != nil {
		reply.Rcode = dns.RcodeNameError
		if lookup.Err() != nil {
			reply.Rcode = dns.RcodeServerFailure
		}
	}
	return reply
}

func (g *gatewayDNS) localAnswer(reply *dns.Msg, question dns.Question, bound bool) bool {
	g.zonesMu.RLock()
	defer g.zonesMu.RUnlock()
	name := dns.CanonicalName(question.Name)
	for _, zone := range g.zones {
		recordName, matched := strings.CutSuffix(name, "."+dns.CanonicalName(zone.Name))
		if !matched {
			continue
		}
		if question.Qtype != dns.TypeA {
			return bound
		}
		ip := zone.DefaultIP.To4()
		for _, record := range zone.Records {
			if (record.Name != "" && strings.EqualFold(record.Name, recordName)) || (record.Regexp != nil && record.Regexp.MatchString(recordName)) {
				ip = record.IP.To4()
				break
			}
		}
		if ip == nil {
			reply.Rcode = dns.RcodeNameError
		} else {
			reply.Answer = []dns.RR{&dns.A{Hdr: gatewayRR(question), A: ip}}
		}
		return true
	}
	return false
}

func (g *gatewayDNS) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/services/dns/all":
		g.zonesMu.RLock()
		defer g.zonesMu.RUnlock()
		_ = json.NewEncoder(w).Encode(g.zones)
	case "/services/dns/add":
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			http.Error(w, "post only", http.StatusBadRequest)
			return
		}
		var zone types.Zone
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&zone); err != nil {
			http.Error(w, "invalid DNS zone", http.StatusBadRequest)
			return
		}
		g.zonesMu.Lock()
		defer g.zonesMu.Unlock()
		for index, existing := range g.zones {
			if existing.Name == zone.Name {
				zone.Records = append(zone.Records, existing.Records...)
				g.zones[index] = zone
				return
			}
		}
		g.zones = append(g.zones, zone)
	default:
		http.NotFound(w, r)
	}
}

type hostDNSResolver interface {
	LookupIPAddr(context.Context, string) ([]net.IPAddr, error)
	LookupCNAME(context.Context, string) (string, error)
	LookupMX(context.Context, string) ([]*net.MX, error)
	LookupNS(context.Context, string) ([]*net.NS, error)
	LookupSRV(context.Context, string, string, string) (string, []*net.SRV, error)
	LookupTXT(context.Context, string) ([]string, error)
}

func gatewayRR(question dns.Question) dns.RR_Header {
	return dns.RR_Header{Name: question.Name, Rrtype: question.Qtype, Class: dns.ClassINET}
}

// Keep the stock gateway's supported system lookup record types for unbound
// instances, including its A-only treatment of address lookups.
func systemDNSAnswer(ctx context.Context, resolver hostDNSResolver, question dns.Question) ([]dns.RR, error) {
	var answers []dns.RR
	name, header := question.Name, gatewayRR(question)
	switch question.Qtype {
	case dns.TypeA:
		addresses, err := resolver.LookupIPAddr(ctx, name)
		for _, address := range addresses {
			if ip := address.IP.To4(); ip != nil {
				answers = append(answers, &dns.A{Hdr: header, A: ip})
			}
		}
		return answers, err
	case dns.TypeCNAME:
		canonical, err := resolver.LookupCNAME(ctx, name)
		if err != nil {
			return nil, err
		}
		return []dns.RR{&dns.CNAME{Hdr: header, Target: canonical}}, nil
	case dns.TypeMX:
		values, err := resolver.LookupMX(ctx, name)
		for _, value := range values {
			answers = append(answers, &dns.MX{Hdr: header, Mx: value.Host, Preference: value.Pref})
		}
		return answers, err
	case dns.TypeNS:
		values, err := resolver.LookupNS(ctx, name)
		for _, value := range values {
			answers = append(answers, &dns.NS{Hdr: header, Ns: value.Host})
		}
		return answers, err
	case dns.TypeSRV:
		_, values, err := resolver.LookupSRV(ctx, "", "", name)
		for _, value := range values {
			answers = append(answers, &dns.SRV{Hdr: header, Priority: value.Priority, Weight: value.Weight, Port: value.Port, Target: value.Target})
		}
		return answers, err
	case dns.TypeTXT:
		values, err := resolver.LookupTXT(ctx, name)
		for _, value := range values {
			answers = append(answers, &dns.TXT{Hdr: header, Txt: []string{value}})
		}
		return answers, err
	default:
		return nil, nil
	}
}
