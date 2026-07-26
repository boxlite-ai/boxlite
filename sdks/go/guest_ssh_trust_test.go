package boxlite

import (
	"strings"
	"testing"
)

func validGuestSshTrust() GuestSshTrust {
	return GuestSshTrust{
		ListenAddr:     "0.0.0.0:22",
		OrganizationID: "org-1",
		BoxID:          "box-1",
		CaKeys: []GuestSshCaKey{
			{KeyID: "ca-current", PublicKey: "ssh-ed25519 AAAACurrent"},
			{KeyID: "ca-next", PublicKey: "ssh-ed25519 AAAANext"},
		},
	}
}

// The option must snapshot the caller's CA keys: a caller that reuses its slice
// after creating one box would otherwise retro-actively change that box's trust.
func TestWithGuestSshTrust_SnapshotsCaKeys(t *testing.T) {
	trust := validGuestSshTrust()
	cfg := &boxConfig{}
	WithGuestSshTrust(trust)(cfg)

	if cfg.sshTrust == nil {
		t.Fatal("WithGuestSshTrust must record the trust on the config")
	}
	if cfg.sshTrust.ListenAddr != "0.0.0.0:22" ||
		cfg.sshTrust.OrganizationID != "org-1" ||
		cfg.sshTrust.BoxID != "box-1" {
		t.Fatalf("identity not recorded: %+v", *cfg.sshTrust)
	}

	trust.CaKeys[0].KeyID = "mutated-after-the-fact"
	if cfg.sshTrust.CaKeys[0].KeyID != "ca-current" {
		t.Fatalf("CA keys must be copied, got %q", cfg.sshTrust.CaKeys[0].KeyID)
	}
}

func TestBuildCOptions_GuestSshTrustUnsetIsANoOp(t *testing.T) {
	cfg := &boxConfig{}
	if cfg.sshTrust != nil {
		t.Fatal("sshTrust must be nil when WithGuestSshTrust is not called")
	}
	if err := buildAndFreeCOptions("alpine:latest", cfg); err != nil {
		t.Fatalf("no SSH trust must build cleanly; got error: %v", err)
	}
}

func TestBuildCOptions_GuestSshTrustApplies(t *testing.T) {
	cfg := &boxConfig{}
	WithGuestSshTrust(validGuestSshTrust())(cfg)

	if err := buildAndFreeCOptions("alpine:latest", cfg); err != nil {
		t.Fatalf("a complete trust bundle must apply cleanly; got error: %v", err)
	}
}

// The core rejects incomplete bundles; these cases prove the rejection actually
// crosses the FFI boundary and surfaces as a Go error rather than producing a
// box whose SSH listener can authenticate nobody.
func TestBuildCOptions_RejectsIncompleteGuestSshTrust(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*GuestSshTrust)
	}{
		{"blank listen address", func(trust *GuestSshTrust) { trust.ListenAddr = "  " }},
		{"missing organization", func(trust *GuestSshTrust) { trust.OrganizationID = "" }},
		{"missing box id", func(trust *GuestSshTrust) { trust.BoxID = "" }},
		{"no CA keys", func(trust *GuestSshTrust) { trust.CaKeys = nil }},
		{"blank CA key id", func(trust *GuestSshTrust) { trust.CaKeys[0].KeyID = "" }},
		{"blank CA public key", func(trust *GuestSshTrust) { trust.CaKeys[0].PublicKey = "" }},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			trust := validGuestSshTrust()
			tc.mutate(&trust)

			cfg := &boxConfig{}
			WithGuestSshTrust(trust)(cfg)

			opts, err := buildCOptions("alpine:latest", cfg)
			if err == nil {
				t.Fatalf("expected rejection, got options %v", opts)
			}
			if !strings.Contains(err.Error(), "guest SSH trust") {
				t.Fatalf("error should name the rejected option: %v", err)
			}
		})
	}
}

// CA key IDs are safe to log; CA public keys are not dumped into errors.
func TestBuildCOptions_GuestSshTrustErrorOmitsPublicKeys(t *testing.T) {
	trust := validGuestSshTrust()
	trust.BoxID = ""
	cfg := &boxConfig{}
	WithGuestSshTrust(trust)(cfg)

	_, err := buildCOptions("alpine:latest", cfg)
	if err == nil {
		t.Fatal("expected rejection for a missing box id")
	}
	for _, ca := range validGuestSshTrust().CaKeys {
		if strings.Contains(err.Error(), ca.PublicKey) {
			t.Fatalf("error must not contain CA public key material: %v", err)
		}
		if !strings.Contains(err.Error(), ca.KeyID) {
			t.Fatalf("error should name CA key id %q for diagnosis: %v", ca.KeyID, err)
		}
	}
}
