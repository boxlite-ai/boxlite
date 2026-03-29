package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// BoxCA is an ephemeral ECDSA P-256 certificate authority for MITM.
type BoxCA struct {
	cert      *x509.Certificate
	key       *ecdsa.PrivateKey
	certPEM   []byte
	certCache sync.Map // hostname -> *tls.Certificate
}

// NewBoxCA generates a new ephemeral CA.
func NewBoxCA() (*BoxCA, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}

	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, err
	}

	now := time.Now()
	template := &x509.Certificate{
		SerialNumber: serial,
		Subject: pkix.Name{
			CommonName: "BoxLite MITM CA",
		},
		NotBefore:             now.Add(-1 * time.Minute),
		NotAfter:              now.Add(24 * time.Hour),
		IsCA:                  true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		BasicConstraintsValid: true,
		MaxPathLen:            0,
	}

	certDER, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		return nil, err
	}

	cert, err := x509.ParseCertificate(certDER)
	if err != nil {
		return nil, err
	}

	certPEM := pem.EncodeToMemory(&pem.Block{
		Type:  "CERTIFICATE",
		Bytes: certDER,
	})

	return &BoxCA{
		cert:    cert,
		key:     key,
		certPEM: certPEM,
	}, nil
}

// CACertPEM returns the CA certificate in PEM format.
func (ca *BoxCA) CACertPEM() []byte {
	return ca.certPEM
}

// CACertPool returns an x509.CertPool containing this CA's certificate.
func (ca *BoxCA) CACertPool() (*x509.CertPool, error) {
	pool := x509.NewCertPool()
	pool.AddCert(ca.cert)
	return pool, nil
}

// GenerateHostCert generates a TLS certificate for the given hostname, signed by this CA.
// Results are cached per-hostname.
func (ca *BoxCA) GenerateHostCert(hostname string) (*tls.Certificate, error) {
	if cached, ok := ca.certCache.Load(hostname); ok {
		return cached.(*tls.Certificate), nil
	}

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}

	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, err
	}

	now := time.Now()
	template := &x509.Certificate{
		SerialNumber:          serial,
		NotBefore:             now.Add(-1 * time.Minute),
		NotAfter:              now.Add(1 * time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
	}

	if ip := net.ParseIP(hostname); ip != nil {
		template.IPAddresses = []net.IP{ip}
	} else {
		template.DNSNames = []string{hostname}
	}

	certDER, err := x509.CreateCertificate(rand.Reader, template, ca.cert, &key.PublicKey, ca.key)
	if err != nil {
		return nil, err
	}

	tlsCert := &tls.Certificate{
		Certificate: [][]byte{certDER, ca.cert.Raw},
		PrivateKey:  key,
	}

	actual, loaded := ca.certCache.LoadOrStore(hostname, tlsCert)
	if loaded {
		return actual.(*tls.Certificate), nil
	}
	return tlsCert, nil
}

// substituteHeaders replaces secret placeholders in request headers and URL query.
func substituteHeaders(req *http.Request, secrets []SecretConfig) {
	if len(secrets) == 0 {
		return
	}

	pairs := make([]string, 0, len(secrets)*2)
	for _, s := range secrets {
		pairs = append(pairs, s.Placeholder, s.Value)
	}
	r := strings.NewReplacer(pairs...)

	for key, vals := range req.Header {
		for i, v := range vals {
			req.Header[key][i] = r.Replace(v)
		}
	}

	if req.URL != nil && req.URL.RawQuery != "" {
		req.URL.RawQuery = r.Replace(req.URL.RawQuery)
	}
}

// SecretHostMatcher provides O(1) lookup for whether a hostname has secrets.
type SecretHostMatcher struct {
	exactHosts       map[string]bool
	wildcardSuffixes []string
	secrets          []SecretConfig
}

// NewSecretHostMatcher builds a matcher from secret configs.
func NewSecretHostMatcher(secrets []SecretConfig) *SecretHostMatcher {
	m := &SecretHostMatcher{
		exactHosts: make(map[string]bool),
		secrets:    secrets,
	}

	for _, s := range secrets {
		for _, host := range s.Hosts {
			h := strings.ToLower(host)
			if strings.HasPrefix(h, "*.") {
				suffix := h[1:] // e.g., ".openai.com"
				m.wildcardSuffixes = append(m.wildcardSuffixes, suffix)
			} else {
				m.exactHosts[h] = true
			}
		}
	}

	return m
}

// Matches returns true if hostname has associated secrets.
func (m *SecretHostMatcher) Matches(hostname string) bool {
	h := strings.ToLower(hostname)
	if m.exactHosts[h] {
		return true
	}
	for _, suffix := range m.wildcardSuffixes {
		// Wildcard *.foo.com matches "bar.foo.com" but not "sub.bar.foo.com"
		if strings.HasSuffix(h, suffix) && !strings.Contains(h[:len(h)-len(suffix)], ".") {
			return true
		}
	}
	return false
}

// SecretsForHost returns all secrets whose Hosts list includes hostname.
func (m *SecretHostMatcher) SecretsForHost(hostname string) []SecretConfig {
	h := strings.ToLower(hostname)
	var result []SecretConfig
	for _, s := range m.secrets {
		for _, host := range s.Hosts {
			host = strings.ToLower(host)
			if host == h {
				result = append(result, s)
				break
			}
			if strings.HasPrefix(host, "*.") {
				suffix := host[1:]
				if strings.HasSuffix(h, suffix) && !strings.Contains(h[:len(h)-len(suffix)], ".") {
					result = append(result, s)
					break
				}
			}
		}
	}
	return result
}
