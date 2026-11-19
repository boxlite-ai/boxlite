package main

import (
	"errors"
	"net/netip"
)

// The host supplies the verified registration and resolver pin. This input is
// write-only and is deliberately separate from the ordinary startup config.
type managedRouteConfig struct {
	Scheme     string         `json:"scheme"`
	Host       string         `json:"host"`
	Port       uint16         `json:"port"`
	DoHURL     string         `json:"doh_url"`
	DoHAddress netip.AddrPort `json:"doh_address"`
	Credential *struct {
		Username string `json:"username"`
		Password string `json:"password"`
	} `json:"credential,omitempty"`
}

func (c *managedRouteConfig) resolver(subnet string, work *dnsLookupWork) (*proxyDNSResolver, error) {
	if c == nil {
		return nil, nil
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
	return newProxyDNSResolver(c.DoHURL, c.DoHAddress, nil, connect, work)
}
