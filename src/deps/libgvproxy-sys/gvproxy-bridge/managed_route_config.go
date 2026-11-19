package main

import (
	"errors"
	"net/netip"
)

type managedProxyBinding struct {
	RegistrationID       string `json:"registration_id"`
	RegistrationRevision string `json:"registration_revision"`
	Epoch                string `json:"epoch"`
}

// The host supplies the verified registration and resolver pin. This input is
// write-only and is deliberately separate from the ordinary startup config.
type managedRouteConfig struct {
	Scheme     string               `json:"scheme"`
	Host       string               `json:"host"`
	Port       uint16               `json:"port"`
	DoHURL     string               `json:"doh_url"`
	DoHAddress netip.AddrPort       `json:"doh_address"`
	Binding    *managedProxyBinding `json:"binding,omitempty"`
	Credential *struct {
		Username string `json:"username"`
		Password string `json:"password"`
	} `json:"credential,omitempty"`
}

func (c *managedRouteConfig) resolver(subnet string, work *dnsLookupWork) (*proxyDNSResolver, error) {
	if c == nil {
		return nil, nil
	}
	if b := c.Binding; b != nil && (!validOutboundRevision(b.RegistrationID) ||
		!validOutboundRevision(b.RegistrationRevision) || !validOutboundRevision(b.Epoch)) {
		return nil, errors.New("invalid managed proxy binding identity")
	}
	protected, err := netip.ParsePrefix(subnet)
	if err != nil {
		return nil, errors.New("invalid protected guest subnet")
	}
	connector := proxyConnectorConfig{scheme: c.Scheme, protected: []netip.Prefix{protected}}
	if c.Credential != nil {
		connector.credential = &proxyCredentials{username: c.Credential.Username, password: c.Credential.Password}
	}
	if !connector.permitsAddress(c.DoHAddress.Addr(), true) {
		return nil, errors.New("invalid pinned DNS resolver address")
	}
	connect, err := newRegisteredProxyConnector(connector, c.Host, c.Port, nil, nil)
	if err != nil {
		return nil, err
	}
	resolver, err := newProxyDNSResolver(c.DoHURL, c.DoHAddress, nil, connect, work)
	if err == nil && c.Binding != nil {
		binding := *c.Binding
		resolver.binding = &binding
	}
	return resolver, err
}
