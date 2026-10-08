package main

import (
	"crypto/x509"
	"testing"
	"time"
)

func TestBoxCA_RenewsHostCertificateOnDayTwo(t *testing.T) {
	ca := newTestCA(t)
	now := time.Now()
	first, err := ca.generateHostCert("api.example.com", now)
	if err != nil {
		t.Fatal(err)
	}
	later := now.Add(48 * time.Hour)
	renewed, err := ca.generateHostCert("api.example.com", later)
	if err != nil {
		t.Fatal(err)
	}
	roots, _ := ca.CACertPool()
	if _, err := renewed.Leaf.Verify(x509.VerifyOptions{
		Roots: roots, DNSName: "api.example.com", CurrentTime: later,
	}); err != nil {
		t.Fatalf("day-two certificate chain must verify: %v", err)
	}
	if renewed == first {
		t.Fatal("expired cached certificate must be replaced")
	}
}

func TestBoxCA_HostCertificateRespectsCAValidity(t *testing.T) {
	ca := newTestCA(t)
	now := time.Now()
	ca.cert.NotAfter = now.Add(time.Hour).Truncate(time.Second)
	cert, err := ca.generateHostCert("api.example.com", now)
	if err != nil {
		t.Fatal(err)
	}
	if cert.Leaf.NotAfter.After(ca.cert.NotAfter) {
		t.Fatal("host certificate must not outlive its CA")
	}
	if cert.Leaf.NotBefore.Before(ca.cert.NotBefore) {
		t.Fatal("host certificate must not predate its CA")
	}
}

func TestBoxCA_RejectsInvalidIssuerEvenWithCachedCertificate(t *testing.T) {
	for _, cached := range []bool{false, true} {
		ca := newTestCA(t)
		if cached {
			if _, err := ca.GenerateHostCert("api.example.com"); err != nil {
				t.Fatal(err)
			}
		}
		for _, at := range []time.Time{ca.cert.NotBefore.Add(-time.Second), ca.cert.NotAfter} {
			if _, err := ca.generateHostCert("api.example.com", at); err == nil {
				t.Fatalf("invalid CA must be rejected (cached=%v, time=%v)", cached, at)
			}
		}
	}
}
