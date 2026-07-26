// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package boxlite

import (
	"context"
	"reflect"
	"strings"
	"testing"

	"github.com/boxlite-ai/runner/pkg/api/dto"
)

func trustDto() *dto.GuestSshTrustDTO {
	return &dto.GuestSshTrustDTO{
		ListenAddr:     "0.0.0.0:22",
		OrganizationId: "org-1",
		BoxId:          "box-1",
		CaKeys: []dto.GuestSshCaKeyDTO{
			{KeyId: "ca-current", PublicKey: "ssh-ed25519 AAAACurrent"},
			{KeyId: "ca-next", PublicKey: "ssh-ed25519 AAAANext"},
		},
	}
}

func TestGuestSshTrustConvertsEveryField(t *testing.T) {
	got := guestSshTrust(trustDto())
	if got == nil {
		t.Fatal("a present trust DTO must convert to an SDK option value")
	}

	if got.ListenAddr != "0.0.0.0:22" || got.OrganizationID != "org-1" || got.BoxID != "box-1" {
		t.Fatalf("identity mismatch: %+v", *got)
	}
	if len(got.CaKeys) != 2 {
		t.Fatalf("expected both CA keys, got %d", len(got.CaKeys))
	}
	if got.CaKeys[0].KeyID != "ca-current" || got.CaKeys[0].PublicKey != "ssh-ed25519 AAAACurrent" {
		t.Fatalf("current CA key mismatch: %+v", got.CaKeys[0])
	}
	if got.CaKeys[1].KeyID != "ca-next" || got.CaKeys[1].PublicKey != "ssh-ed25519 AAAANext" {
		t.Fatalf("next CA key mismatch: %+v", got.CaKeys[1])
	}
}

func TestGuestSshTrustAbsentMeansNoListener(t *testing.T) {
	if got := guestSshTrust(nil); got != nil {
		t.Fatalf("a box without SSH trust must get no option, got %+v", *got)
	}
}

// Trust is typed box configuration, not container environment: leaking it into
// the guest env would put CA material in a world-readable place and bypass the
// option that stop/start replays.
func TestGuestSshTrustNeverReachesBoxRuntimeEnv(t *testing.T) {
	env := boxRuntimeEnv(context.Background(), dto.CreateBoxDTO{
		Id:            "box-1",
		GuestSshTrust: trustDto(),
	})

	for key, value := range env {
		for _, ca := range trustDto().CaKeys {
			if strings.Contains(value, ca.PublicKey) || strings.Contains(value, ca.KeyId) {
				t.Fatalf("env %s=%q must not carry SSH trust material", key, value)
			}
		}
	}
}

func TestGuestSshCaKeyIdsAreIdOnly(t *testing.T) {
	got := guestSshCaKeyIds(trustDto())
	want := []string{"ca-current", "ca-next"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("guestSshCaKeyIds() = %v, want %v", got, want)
	}
	if got := guestSshCaKeyIds(nil); got != nil {
		t.Fatalf("guestSshCaKeyIds(nil) = %v, want nil", got)
	}
}

// Recovery rebuilds the VM from the recover DTO alone, so trust must survive
// the CreateBoxDTO re-synthesis or the recovered box comes back without its
// SSH listener.
func TestRecoverCreateDtoCarriesGuestSshTrust(t *testing.T) {
	trust := trustDto()
	got := recoverCreateDto("box-1", dto.RecoverBoxDTO{
		OsUser:        "root",
		CpuQuota:      2,
		MemoryQuota:   4,
		StorageQuota:  8,
		ErrorReason:   "boot failed",
		GuestSshTrust: trust,
	})

	if got.GuestSshTrust != trust {
		t.Fatalf("recovered create DTO must carry the trust bundle, got %+v", got.GuestSshTrust)
	}
	if got.Id != "box-1" {
		t.Fatalf("recovered create DTO id = %q", got.Id)
	}
}

func TestRecoverCreateDtoWithoutTrustStaysDisabled(t *testing.T) {
	got := recoverCreateDto("box-1", dto.RecoverBoxDTO{
		OsUser:       "root",
		CpuQuota:     2,
		MemoryQuota:  4,
		StorageQuota: 8,
		ErrorReason:  "boot failed",
	})

	if got.GuestSshTrust != nil {
		t.Fatalf("no trust in, no trust out; got %+v", got.GuestSshTrust)
	}
}
