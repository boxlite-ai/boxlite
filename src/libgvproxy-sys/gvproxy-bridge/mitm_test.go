package main

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"sync"
	"testing"
	"time"
)

// ============================================================================
// Section A: BoxCA Tests
// ============================================================================

func TestBoxCA_Creation(t *testing.T) {
	ca := newTestCA(t)

	if !ca.cert.IsCA {
		t.Error("CA certificate IsCA should be true")
	}
	if ca.cert.PublicKeyAlgorithm != x509.ECDSA {
		t.Errorf("expected ECDSA, got %v", ca.cert.PublicKeyAlgorithm)
	}
	if ca.cert.KeyUsage&x509.KeyUsageCertSign == 0 {
		t.Error("CA cert should have KeyUsageCertSign")
	}
	if ca.cert.Subject.CommonName == "" {
		t.Error("CA cert CommonName should be non-empty")
	}
	now := time.Now()
	if now.Before(ca.cert.NotBefore) {
		t.Errorf("CA cert NotBefore (%v) is in the future", ca.cert.NotBefore)
	}
	if now.After(ca.cert.NotAfter) {
		t.Errorf("CA cert NotAfter (%v) is in the past", ca.cert.NotAfter)
	}
}

func TestBoxCA_CACertPEM(t *testing.T) {
	ca := newTestCA(t)

	pemBytes := ca.CACertPEM()
	if len(pemBytes) == 0 {
		t.Fatal("CACertPEM() returned empty bytes")
	}

	block, _ := pem.Decode(pemBytes)
	if block == nil {
		t.Fatal("pem.Decode returned nil block")
	}
	if block.Type != "CERTIFICATE" {
		t.Errorf("expected PEM type CERTIFICATE, got %q", block.Type)
	}

	parsed, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatalf("x509.ParseCertificate error: %v", err)
	}
	if parsed.SerialNumber.Cmp(ca.cert.SerialNumber) != 0 {
		t.Error("parsed cert serial number does not match ca.cert")
	}
}

func TestBoxCA_GenerateHostCert_Valid(t *testing.T) {
	ca := newTestCA(t)

	tlsCert, err := ca.GenerateHostCert("api.openai.com")
	if err != nil {
		t.Fatalf("GenerateHostCert error: %v", err)
	}

	leaf, err := x509.ParseCertificate(tlsCert.Certificate[0])
	if err != nil {
		t.Fatalf("parse leaf cert: %v", err)
	}

	if !containsString(leaf.DNSNames, "api.openai.com") {
		t.Errorf("DNSNames %v should contain api.openai.com", leaf.DNSNames)
	}
	if leaf.IsCA {
		t.Error("leaf cert should not be CA")
	}
	if leaf.PublicKeyAlgorithm != x509.ECDSA {
		t.Errorf("expected ECDSA, got %v", leaf.PublicKeyAlgorithm)
	}

	pool := x509.NewCertPool()
	pool.AddCert(ca.cert)
	if _, err := leaf.Verify(x509.VerifyOptions{
		Roots:   pool,
		DNSName: "api.openai.com",
	}); err != nil {
		t.Errorf("cert verification failed: %v", err)
	}
}

func TestBoxCA_GenerateHostCert_Wildcard(t *testing.T) {
	ca := newTestCA(t)

	tlsCert, err := ca.GenerateHostCert("*.openai.com")
	if err != nil {
		t.Fatalf("GenerateHostCert error: %v", err)
	}

	leaf, err := x509.ParseCertificate(tlsCert.Certificate[0])
	if err != nil {
		t.Fatalf("parse leaf cert: %v", err)
	}

	if !containsString(leaf.DNSNames, "*.openai.com") {
		t.Errorf("DNSNames %v should contain *.openai.com", leaf.DNSNames)
	}

	pool := x509.NewCertPool()
	pool.AddCert(ca.cert)
	if _, err := leaf.Verify(x509.VerifyOptions{
		Roots:   pool,
		DNSName: "api.openai.com",
	}); err != nil {
		t.Errorf("wildcard cert should verify for api.openai.com: %v", err)
	}
}

func TestBoxCA_GenerateHostCert_IPAddress(t *testing.T) {
	ca := newTestCA(t)

	tlsCert, err := ca.GenerateHostCert("192.168.1.1")
	if err != nil {
		t.Fatalf("GenerateHostCert error: %v", err)
	}

	leaf, err := x509.ParseCertificate(tlsCert.Certificate[0])
	if err != nil {
		t.Fatalf("parse leaf cert: %v", err)
	}

	expectedIP := net.ParseIP("192.168.1.1")
	found := false
	for _, ip := range leaf.IPAddresses {
		if ip.Equal(expectedIP) {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("IPAddresses %v should contain 192.168.1.1", leaf.IPAddresses)
	}
	if len(leaf.DNSNames) != 0 {
		t.Errorf("IP cert should have empty DNSNames, got %v", leaf.DNSNames)
	}
}

func TestBoxCA_GenerateHostCert_Localhost(t *testing.T) {
	ca := newTestCA(t)

	tlsCert, err := ca.GenerateHostCert("localhost")
	if err != nil {
		t.Fatalf("GenerateHostCert error: %v", err)
	}

	leaf, err := x509.ParseCertificate(tlsCert.Certificate[0])
	if err != nil {
		t.Fatalf("parse leaf cert: %v", err)
	}

	if !containsString(leaf.DNSNames, "localhost") {
		t.Errorf("DNSNames %v should contain localhost", leaf.DNSNames)
	}

	pool := x509.NewCertPool()
	pool.AddCert(ca.cert)
	if _, err := leaf.Verify(x509.VerifyOptions{
		Roots:   pool,
		DNSName: "localhost",
	}); err != nil {
		t.Errorf("localhost cert verification failed: %v", err)
	}
}

func TestBoxCA_CertCache_Hit(t *testing.T) {
	ca := newTestCA(t)

	cert1, err := ca.GenerateHostCert("api.openai.com")
	if err != nil {
		t.Fatalf("first call error: %v", err)
	}
	cert2, err := ca.GenerateHostCert("api.openai.com")
	if err != nil {
		t.Fatalf("second call error: %v", err)
	}

	if cert1 != cert2 {
		t.Error("same hostname should return same *tls.Certificate pointer")
	}
}

func TestBoxCA_CertCache_DifferentHosts(t *testing.T) {
	ca := newTestCA(t)

	certA, err := ca.GenerateHostCert("a.com")
	if err != nil {
		t.Fatalf("a.com error: %v", err)
	}
	certB, err := ca.GenerateHostCert("b.com")
	if err != nil {
		t.Fatalf("b.com error: %v", err)
	}

	if certA == certB {
		t.Error("different hostnames should return different cert pointers")
	}

	leafA, _ := x509.ParseCertificate(certA.Certificate[0])
	leafB, _ := x509.ParseCertificate(certB.Certificate[0])
	if leafA.SerialNumber.Cmp(leafB.SerialNumber) == 0 {
		t.Error("different hostnames should have different serial numbers")
	}
}

func TestBoxCA_CertCache_ConcurrentSameHost(t *testing.T) {
	ca := newTestCA(t)

	const n = 100
	certs := make([]*tls.Certificate, n)
	errs := make([]error, n)
	var wg sync.WaitGroup
	wg.Add(n)

	for i := 0; i < n; i++ {
		go func(idx int) {
			defer wg.Done()
			certs[idx], errs[idx] = ca.GenerateHostCert("api.openai.com")
		}(i)
	}
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Fatalf("goroutine %d error: %v", i, err)
		}
	}

	first := certs[0]
	for i := 1; i < n; i++ {
		if certs[i] != first {
			t.Errorf("goroutine %d got different pointer than goroutine 0", i)
		}
	}
}

func TestBoxCA_CertCache_ConcurrentDifferentHosts(t *testing.T) {
	ca := newTestCA(t)

	const n = 100
	const numHosts = 10
	hosts := make([]string, numHosts)
	for i := 0; i < numHosts; i++ {
		hosts[i] = fmt.Sprintf("host%d.example.com", i)
	}

	certs := make([]*tls.Certificate, n)
	errs := make([]error, n)
	var wg sync.WaitGroup
	wg.Add(n)

	for i := 0; i < n; i++ {
		go func(idx int) {
			defer wg.Done()
			certs[idx], errs[idx] = ca.GenerateHostCert(hosts[idx%numHosts])
		}(i)
	}
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Fatalf("goroutine %d error: %v", i, err)
		}
	}

	unique := make(map[*tls.Certificate]bool)
	for _, c := range certs {
		unique[c] = true
	}
	if len(unique) != numHosts {
		t.Errorf("expected %d unique certs, got %d", numHosts, len(unique))
	}
}

func TestBoxCA_TLSHandshake_H1(t *testing.T) {
	ca := newTestCA(t)

	tlsCert, err := ca.GenerateHostCert("test.example.com")
	if err != nil {
		t.Fatalf("GenerateHostCert error: %v", err)
	}

	serverConn, clientConn := net.Pipe()
	defer serverConn.Close()
	defer clientConn.Close()

	serverTLSConf := &tls.Config{
		Certificates: []tls.Certificate{*tlsCert},
		NextProtos:   []string{"http/1.1"},
	}
	pool := x509.NewCertPool()
	pool.AddCert(ca.cert)
	clientTLSConf := &tls.Config{
		RootCAs:    pool,
		ServerName: "test.example.com",
		NextProtos: []string{"http/1.1"},
	}

	errCh := make(chan error, 2)
	go func() {
		srv := tls.Server(serverConn, serverTLSConf)
		errCh <- srv.Handshake()
	}()
	go func() {
		cli := tls.Client(clientConn, clientTLSConf)
		errCh <- cli.Handshake()
	}()

	for i := 0; i < 2; i++ {
		if hsErr := <-errCh; hsErr != nil {
			t.Errorf("handshake error: %v", hsErr)
		}
	}
}

func TestBoxCA_TLSHandshake_H2(t *testing.T) {
	ca := newTestCA(t)

	tlsCert, err := ca.GenerateHostCert("test.example.com")
	if err != nil {
		t.Fatalf("GenerateHostCert error: %v", err)
	}

	serverConn, clientConn := net.Pipe()
	defer serverConn.Close()
	defer clientConn.Close()

	serverTLSConf := &tls.Config{
		Certificates: []tls.Certificate{*tlsCert},
		NextProtos:   []string{"h2", "http/1.1"},
	}
	pool := x509.NewCertPool()
	pool.AddCert(ca.cert)
	clientTLSConf := &tls.Config{
		RootCAs:    pool,
		ServerName: "test.example.com",
		NextProtos: []string{"h2", "http/1.1"},
	}

	type hsResult struct {
		state tls.ConnectionState
		err   error
	}

	srvCh := make(chan error, 1)
	cliCh := make(chan hsResult, 1)

	go func() {
		srv := tls.Server(serverConn, serverTLSConf)
		srvCh <- srv.Handshake()
	}()
	go func() {
		cli := tls.Client(clientConn, clientTLSConf)
		err := cli.Handshake()
		cliCh <- hsResult{state: cli.ConnectionState(), err: err}
	}()

	if srvErr := <-srvCh; srvErr != nil {
		t.Fatalf("server handshake error: %v", srvErr)
	}
	result := <-cliCh
	if result.err != nil {
		t.Fatalf("client handshake error: %v", result.err)
	}
	if result.state.NegotiatedProtocol != "h2" {
		t.Errorf("expected h2, got %q", result.state.NegotiatedProtocol)
	}
}

func TestBoxCA_TLSHandshake_UntrustedCA(t *testing.T) {
	ca := newTestCA(t)

	tlsCert, err := ca.GenerateHostCert("test.example.com")
	if err != nil {
		t.Fatalf("GenerateHostCert error: %v", err)
	}

	serverConn, clientConn := net.Pipe()
	defer serverConn.Close()
	defer clientConn.Close()

	serverTLSConf := &tls.Config{
		Certificates: []tls.Certificate{*tlsCert},
	}
	// Empty RootCAs -- CA is not trusted
	clientTLSConf := &tls.Config{
		RootCAs:    x509.NewCertPool(),
		ServerName: "test.example.com",
	}

	errCh := make(chan error, 2)
	go func() {
		srv := tls.Server(serverConn, serverTLSConf)
		errCh <- srv.Handshake()
	}()

	cli := tls.Client(clientConn, clientTLSConf)
	clientErr := cli.Handshake()
	if clientErr == nil {
		t.Fatal("expected handshake error with untrusted CA, got nil")
	}
}

// ============================================================================
// Section B: Header Substitution Tests
// ============================================================================

func TestSubstituteHeaders_Authorization(t *testing.T) {
	req := &http.Request{
		Header: http.Header{},
	}
	req.Header.Set("Authorization", "Bearer <BOXLITE_SECRET:openai>")

	secrets := []SecretConfig{
		{Placeholder: "<BOXLITE_SECRET:openai>", Value: "sk-real-key"},
	}
	substituteHeaders(req, secrets)

	got := req.Header.Get("Authorization")
	want := "Bearer sk-real-key"
	if got != want {
		t.Errorf("Authorization = %q, want %q", got, want)
	}
}

func TestSubstituteHeaders_MultipleHeaders(t *testing.T) {
	req := &http.Request{
		Header: http.Header{},
	}
	req.Header.Set("Authorization", "Bearer <BOXLITE_SECRET:a>")
	req.Header.Set("X-API-Key", "<BOXLITE_SECRET:b>")

	secrets := []SecretConfig{
		{Placeholder: "<BOXLITE_SECRET:a>", Value: "value-a"},
		{Placeholder: "<BOXLITE_SECRET:b>", Value: "value-b"},
	}
	substituteHeaders(req, secrets)

	if got := req.Header.Get("Authorization"); got != "Bearer value-a" {
		t.Errorf("Authorization = %q, want %q", got, "Bearer value-a")
	}
	if got := req.Header.Get("X-API-Key"); got != "value-b" {
		t.Errorf("X-API-Key = %q, want %q", got, "value-b")
	}
}

func TestSubstituteHeaders_NoMatch(t *testing.T) {
	req := &http.Request{
		Header: http.Header{},
	}
	req.Header.Set("Authorization", "Bearer real-key-already")

	secrets := []SecretConfig{
		{Placeholder: "<BOXLITE_SECRET:openai>", Value: "sk-real-key"},
	}
	substituteHeaders(req, secrets)

	got := req.Header.Get("Authorization")
	if got != "Bearer real-key-already" {
		t.Errorf("Authorization should be unchanged, got %q", got)
	}
}

func TestSubstituteHeaders_CustomHeader(t *testing.T) {
	req := &http.Request{
		Header: http.Header{},
	}
	req.Header.Set("X-Custom", "prefix-<BOXLITE_SECRET:tok>-suffix")

	secrets := []SecretConfig{
		{Placeholder: "<BOXLITE_SECRET:tok>", Value: "real-value"},
	}
	substituteHeaders(req, secrets)

	got := req.Header.Get("X-Custom")
	want := "prefix-real-value-suffix"
	if got != want {
		t.Errorf("X-Custom = %q, want %q", got, want)
	}
}

func TestSubstituteHeaders_MultiValueHeader(t *testing.T) {
	req := &http.Request{
		Header: http.Header{},
	}
	req.Header.Add("X-Multi", "first-<BOXLITE_SECRET:s>")
	req.Header.Add("X-Multi", "second-<BOXLITE_SECRET:s>")

	secrets := []SecretConfig{
		{Placeholder: "<BOXLITE_SECRET:s>", Value: "replaced"},
	}
	substituteHeaders(req, secrets)

	vals := req.Header.Values("X-Multi")
	if len(vals) != 2 {
		t.Fatalf("expected 2 values, got %d", len(vals))
	}
	if vals[0] != "first-replaced" {
		t.Errorf("vals[0] = %q, want %q", vals[0], "first-replaced")
	}
	if vals[1] != "second-replaced" {
		t.Errorf("vals[1] = %q, want %q", vals[1], "second-replaced")
	}
}

func TestSubstituteHeaders_URLQueryString(t *testing.T) {
	u, _ := url.Parse("https://api.example.com/v1?key=<BOXLITE_SECRET:k>&other=foo")
	req := &http.Request{
		Header: http.Header{},
		URL:    u,
	}

	secrets := []SecretConfig{
		{Placeholder: "<BOXLITE_SECRET:k>", Value: "real-value"},
	}
	substituteHeaders(req, secrets)

	q := req.URL.Query()
	if got := q.Get("key"); got != "real-value" {
		t.Errorf("URL query key = %q, want %q", got, "real-value")
	}
	if got := q.Get("other"); got != "foo" {
		t.Errorf("URL query other = %q, want %q", got, "foo")
	}
}

func TestSubstituteHeaders_NoSecrets(t *testing.T) {
	u, _ := url.Parse("https://api.example.com/v1?key=val")
	req := &http.Request{
		Header: http.Header{},
		URL:    u,
	}
	req.Header.Set("Authorization", "Bearer tok")

	substituteHeaders(req, nil)

	if got := req.Header.Get("Authorization"); got != "Bearer tok" {
		t.Errorf("Authorization should be unchanged, got %q", got)
	}
	if got := req.URL.Query().Get("key"); got != "val" {
		t.Errorf("URL query key should be unchanged, got %q", got)
	}
}

func TestSubstituteHeaders_EmptySecrets(t *testing.T) {
	req := &http.Request{
		Header: http.Header{},
	}
	req.Header.Set("Authorization", "Bearer <BOXLITE_SECRET:k>")

	substituteHeaders(req, []SecretConfig{})

	got := req.Header.Get("Authorization")
	if got != "Bearer <BOXLITE_SECRET:k>" {
		t.Errorf("empty secrets slice should leave header unchanged, got %q", got)
	}
}

func TestSubstituteHeaders_MultiplePlaceholdersInOneValue(t *testing.T) {
	req := &http.Request{
		Header: http.Header{},
	}
	req.Header.Set("Authorization", "Basic <BOXLITE_SECRET:user>:<BOXLITE_SECRET:pass>")

	secrets := []SecretConfig{
		{Placeholder: "<BOXLITE_SECRET:user>", Value: "admin"},
		{Placeholder: "<BOXLITE_SECRET:pass>", Value: "s3cret"},
	}
	substituteHeaders(req, secrets)

	got := req.Header.Get("Authorization")
	want := "Basic admin:s3cret"
	if got != want {
		t.Errorf("Authorization = %q, want %q", got, want)
	}
}

func TestSubstituteHeaders_DuplicatePlaceholderInOneValue(t *testing.T) {
	req := &http.Request{
		Header: http.Header{},
	}
	req.Header.Set("X-Token", "<BOXLITE_SECRET:k>-and-<BOXLITE_SECRET:k>")

	secrets := []SecretConfig{
		{Placeholder: "<BOXLITE_SECRET:k>", Value: "val"},
	}
	substituteHeaders(req, secrets)

	got := req.Header.Get("X-Token")
	want := "val-and-val"
	if got != want {
		t.Errorf("X-Token = %q, want %q", got, want)
	}
}

func TestSubstituteHeaders_MultipleQueryParams(t *testing.T) {
	u, _ := url.Parse("https://api.example.com/v1?key=<BOXLITE_SECRET:a>&token=<BOXLITE_SECRET:b>&plain=hello")
	req := &http.Request{
		Header: http.Header{},
		URL:    u,
	}

	secrets := []SecretConfig{
		{Placeholder: "<BOXLITE_SECRET:a>", Value: "key-val"},
		{Placeholder: "<BOXLITE_SECRET:b>", Value: "tok-val"},
	}
	substituteHeaders(req, secrets)

	q := req.URL.Query()
	if got := q.Get("key"); got != "key-val" {
		t.Errorf("URL query key = %q, want %q", got, "key-val")
	}
	if got := q.Get("token"); got != "tok-val" {
		t.Errorf("URL query token = %q, want %q", got, "tok-val")
	}
	if got := q.Get("plain"); got != "hello" {
		t.Errorf("URL query plain should be unchanged, got %q", got)
	}
}

func TestSubstituteHeaders_HeaderAndQueryCombined(t *testing.T) {
	u, _ := url.Parse("https://api.example.com/v1?api_key=<BOXLITE_SECRET:k>")
	req := &http.Request{
		Header: http.Header{},
		URL:    u,
	}
	req.Header.Set("Authorization", "Bearer <BOXLITE_SECRET:k>")

	secrets := []SecretConfig{
		{Placeholder: "<BOXLITE_SECRET:k>", Value: "real-key"},
	}
	substituteHeaders(req, secrets)

	if got := req.Header.Get("Authorization"); got != "Bearer real-key" {
		t.Errorf("Authorization = %q, want %q", got, "Bearer real-key")
	}
	if got := req.URL.Query().Get("api_key"); got != "real-key" {
		t.Errorf("URL query api_key = %q, want %q", got, "real-key")
	}
}

func TestSubstituteHeaders_PlaceholderIsEntireValue(t *testing.T) {
	req := &http.Request{
		Header: http.Header{},
	}
	req.Header.Set("X-API-Key", "<BOXLITE_SECRET:full>")

	secrets := []SecretConfig{
		{Placeholder: "<BOXLITE_SECRET:full>", Value: "the-whole-value"},
	}
	substituteHeaders(req, secrets)

	got := req.Header.Get("X-API-Key")
	if got != "the-whole-value" {
		t.Errorf("X-API-Key = %q, want %q", got, "the-whole-value")
	}
}

func TestSubstituteHeaders_ValueContainsSpecialChars(t *testing.T) {
	req := &http.Request{
		Header: http.Header{},
	}
	req.Header.Set("Authorization", "Bearer <BOXLITE_SECRET:k>")

	secrets := []SecretConfig{
		{Placeholder: "<BOXLITE_SECRET:k>", Value: "sk-proj-abc123/+=="},
	}
	substituteHeaders(req, secrets)

	got := req.Header.Get("Authorization")
	want := "Bearer sk-proj-abc123/+=="
	if got != want {
		t.Errorf("Authorization = %q, want %q", got, want)
	}
}

func TestSubstituteHeaders_ManySecrets(t *testing.T) {
	req := &http.Request{
		Header: http.Header{},
	}

	secrets := make([]SecretConfig, 50)
	for i := 0; i < 50; i++ {
		key := fmt.Sprintf("X-Key-%d", i)
		placeholder := fmt.Sprintf("<BOXLITE_SECRET:s%d>", i)
		value := fmt.Sprintf("real-%d", i)
		req.Header.Set(key, placeholder)
		secrets[i] = SecretConfig{Placeholder: placeholder, Value: value}
	}
	substituteHeaders(req, secrets)

	for i := 0; i < 50; i++ {
		key := fmt.Sprintf("X-Key-%d", i)
		want := fmt.Sprintf("real-%d", i)
		if got := req.Header.Get(key); got != want {
			t.Errorf("%s = %q, want %q", key, got, want)
		}
	}
}

func TestSubstituteHeaders_NilURL(t *testing.T) {
	req := &http.Request{
		Header: http.Header{},
		URL:    nil,
	}
	req.Header.Set("Authorization", "Bearer <BOXLITE_SECRET:k>")

	secrets := []SecretConfig{
		{Placeholder: "<BOXLITE_SECRET:k>", Value: "real"},
	}

	// Should not panic with nil URL
	substituteHeaders(req, secrets)

	got := req.Header.Get("Authorization")
	if got != "Bearer real" {
		t.Errorf("Authorization = %q, want %q", got, "Bearer real")
	}
}

func TestSubstituteHeaders_Concurrent(t *testing.T) {
	secrets := []SecretConfig{
		{Placeholder: "<BOXLITE_SECRET:k>", Value: "real-value"},
	}

	var wg sync.WaitGroup
	const n = 100
	wg.Add(n)

	for i := 0; i < n; i++ {
		go func() {
			defer wg.Done()
			req := &http.Request{
				Header: http.Header{},
			}
			req.Header.Set("Authorization", "Bearer <BOXLITE_SECRET:k>")
			substituteHeaders(req, secrets)

			got := req.Header.Get("Authorization")
			if got != "Bearer real-value" {
				t.Errorf("concurrent substitution failed: got %q", got)
			}
		}()
	}
	wg.Wait()
}

// ============================================================================
// Section C: Secret Host Matching Tests
// ============================================================================

func TestSecretHostMatch_Exact(t *testing.T) {
	m := NewSecretHostMatcher([]SecretConfig{
		{Hosts: []string{"api.openai.com"}},
	})

	tests := []struct {
		host string
		want bool
	}{
		{"api.openai.com", true},
		{"other.openai.com", false},
		{"api.openai.com.evil.com", false},
	}
	for _, tt := range tests {
		t.Run(tt.host, func(t *testing.T) {
			if got := m.Matches(tt.host); got != tt.want {
				t.Errorf("Matches(%q) = %v, want %v", tt.host, got, tt.want)
			}
		})
	}
}

func TestSecretHostMatch_Wildcard(t *testing.T) {
	m := NewSecretHostMatcher([]SecretConfig{
		{Hosts: []string{"*.openai.com"}},
	})

	tests := []struct {
		host string
		want bool
	}{
		{"api.openai.com", true},
		{"chat.openai.com", true},
		{"openai.com", false},
		{"sub.api.openai.com", false},
	}
	for _, tt := range tests {
		t.Run(tt.host, func(t *testing.T) {
			if got := m.Matches(tt.host); got != tt.want {
				t.Errorf("Matches(%q) = %v, want %v", tt.host, got, tt.want)
			}
		})
	}
}

func TestSecretHostMatch_MultipleHosts(t *testing.T) {
	m := NewSecretHostMatcher([]SecretConfig{
		{Hosts: []string{"a.com", "b.com"}},
	})

	if !m.Matches("a.com") {
		t.Error("a.com should match")
	}
	if !m.Matches("b.com") {
		t.Error("b.com should match")
	}
	if m.Matches("c.com") {
		t.Error("c.com should not match")
	}
}

func TestSecretHostMatch_CaseInsensitive(t *testing.T) {
	m := NewSecretHostMatcher([]SecretConfig{
		{Hosts: []string{"API.OpenAI.com"}},
	})

	if !m.Matches("api.openai.com") {
		t.Error("case-insensitive match should succeed for api.openai.com")
	}
}

func TestSecretHostMatch_MultipleSecretsSameHost(t *testing.T) {
	secrets := []SecretConfig{
		{Name: "a", Hosts: []string{"x.com"}},
		{Name: "b", Hosts: []string{"x.com"}},
	}
	m := NewSecretHostMatcher(secrets)

	if !m.Matches("x.com") {
		t.Error("x.com should match")
	}

	got := m.SecretsForHost("x.com")
	if len(got) != 2 {
		t.Fatalf("SecretsForHost(x.com) returned %d secrets, want 2", len(got))
	}

	names := map[string]bool{}
	for _, s := range got {
		names[s.Name] = true
	}
	if !names["a"] || !names["b"] {
		t.Errorf("expected secrets a and b, got %v", got)
	}
}

// ============================================================================
// Helpers
// ============================================================================

func containsString(ss []string, target string) bool {
	for _, s := range ss {
		if s == target {
			return true
		}
	}
	return false
}
