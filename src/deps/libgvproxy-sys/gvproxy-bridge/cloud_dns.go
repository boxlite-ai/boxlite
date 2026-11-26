package main

import (
	"context"
	"fmt"
	"net"
	"net/netip"
	"time"

	"github.com/miekg/dns"
)

const cloudDNSLookupTimeout = 4 * time.Second

// Cloud DNS and hostname forwarding share this immutable list of literal
// resolvers. No lookup goes through the operating system's resolver.
type cloudDNSResolver struct {
	endpoints []netip.AddrPort
}

func (r *cloudDNSResolver) ResolveDNS(ctx context.Context, question dns.Question) ([]dns.RR, int) {
	response, err := r.query(ctx, question)
	if err != nil {
		return nil, dns.RcodeServerFailure
	}
	return response.Answer, response.Rcode
}

func (r *cloudDNSResolver) lookupHost(ctx context.Context, host string) ([]net.IP, error) {
	name := dns.CanonicalName(host)
	response, err := r.query(ctx, dns.Question{Name: name, Qtype: dns.TypeA, Qclass: dns.ClassINET})
	if err != nil {
		return nil, err
	}
	if response.Rcode != dns.RcodeSuccess {
		return nil, fmt.Errorf("Cloud DNS returned %s", dns.RcodeToString[response.Rcode])
	}
	// A recursive resolver can return an alias chain. Unrelated A records
	// must never become connection candidates for the requested hostname.
	addresses := make(map[string][]net.IP)
	aliases := make(map[string]string)
	for _, record := range response.Answer {
		if record.Header().Class != dns.ClassINET {
			continue
		}
		owner := dns.CanonicalName(record.Header().Name)
		switch record := record.(type) {
		case *dns.A:
			if address := record.A.To4(); address != nil {
				addresses[owner] = append(addresses[owner], address)
			}
		case *dns.CNAME:
			aliases[owner] = dns.CanonicalName(record.Target)
		}
	}
	for range len(aliases) + 1 {
		if ips := addresses[name]; len(ips) != 0 {
			return ips, nil
		}
		if name = aliases[name]; name == "" {
			break
		}
	}
	return nil, fmt.Errorf("Cloud DNS returned no IPv4 address for %s", host)
}

func (r *cloudDNSResolver) query(ctx context.Context, question dns.Question) (*dns.Msg, error) {
	if _, valid := dns.IsDomainName(question.Name); !valid || question.Qclass != dns.ClassINET {
		return nil, fmt.Errorf("invalid Cloud DNS question")
	}
	ctx, cancel := context.WithTimeout(ctx, cloudDNSLookupTimeout)
	defer cancel()
	deadline, _ := ctx.Deadline()
	request := new(dns.Msg)
	request.SetQuestion(question.Name, question.Qtype)
	var lastErr error
	for i, endpoint := range r.endpoints {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		attempt, stop := context.WithDeadline(ctx, candidateDeadline(time.Now(), deadline, len(r.endpoints)-i))
		response, err := exchangeCloudDNS(attempt, request, endpoint, "udp4")
		if err == nil && response.Truncated {
			response, err = exchangeCloudDNS(attempt, request, endpoint, "tcp4")
		}
		stop()
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if err != nil {
			lastErr = err
			continue
		}
		if !response.Truncated && (response.Rcode == dns.RcodeSuccess || response.Rcode == dns.RcodeNameError) {
			return response, nil
		}
		lastErr = fmt.Errorf("unusable Cloud DNS response")
	}
	return nil, fmt.Errorf("Cloud DNS resolvers exhausted: %w", lastErr)
}

func exchangeCloudDNS(ctx context.Context, request *dns.Msg, endpoint netip.AddrPort, network string) (*dns.Msg, error) {
	client := dns.Client{Net: network}
	conn, err := client.DialContext(ctx, endpoint.String())
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	response, _, err := client.ExchangeWithConnContext(ctx, request, conn)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if !response.Response || response.Opcode != dns.OpcodeQuery || len(response.Question) != 1 {
		return nil, fmt.Errorf("Cloud DNS response does not match its question")
	}
	responseQuestion, requestQuestion := response.Question[0], request.Question[0]
	if dns.CanonicalName(responseQuestion.Name) != dns.CanonicalName(requestQuestion.Name) ||
		responseQuestion.Qtype != requestQuestion.Qtype || responseQuestion.Qclass != requestQuestion.Qclass {
		return nil, fmt.Errorf("Cloud DNS response does not match its question")
	}
	return response, nil
}
