// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package api

import (
	"testing"

	"github.com/boxlite-ai/runner/pkg/api/dto"
)

func validTrustDto() dto.GuestSshTrustDTO {
	return dto.GuestSshTrustDTO{
		ListenAddr:     "0.0.0.0:22",
		OrganizationId: "org-1",
		BoxId:          "box-1",
		CaKeys: []dto.GuestSshCaKeyDTO{
			{KeyId: "ca-current", PublicKey: "ssh-ed25519 AAAACurrent"},
		},
	}
}

func TestGuestSshTrustDTOAcceptsACompleteBundle(t *testing.T) {
	if err := (&DefaultValidator{}).ValidateStruct(validTrustDto()); err != nil {
		t.Fatalf("a complete trust bundle must validate: %v", err)
	}
}

// Trust reaching the runtime half-formed produces a guest listener that can
// authenticate nobody, so the incomplete shapes have to be rejected at the
// request boundary rather than deep in the FFI.
func TestGuestSshTrustDTORejectsIncompleteBundles(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*dto.GuestSshTrustDTO)
	}{
		{"missing listen address", func(trust *dto.GuestSshTrustDTO) { trust.ListenAddr = "" }},
		{"listen address without port", func(trust *dto.GuestSshTrustDTO) { trust.ListenAddr = "0.0.0.0" }},
		{"missing organization", func(trust *dto.GuestSshTrustDTO) { trust.OrganizationId = "" }},
		{"missing box id", func(trust *dto.GuestSshTrustDTO) { trust.BoxId = "" }},
		{"no CA keys", func(trust *dto.GuestSshTrustDTO) { trust.CaKeys = nil }},
		{"CA key without id", func(trust *dto.GuestSshTrustDTO) { trust.CaKeys[0].KeyId = "" }},
		{"CA key without public key", func(trust *dto.GuestSshTrustDTO) { trust.CaKeys[0].PublicKey = "" }},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			trust := validTrustDto()
			tc.mutate(&trust)
			if err := (&DefaultValidator{}).ValidateStruct(trust); err == nil {
				t.Fatalf("expected rejection for %s", tc.name)
			}
		})
	}
}

// The field is optional on both carriers, but must still be validated when
// present — a nested struct that skipped validation would be worse than no tag.
func TestCreateAndRecoverBoxDTOValidateNestedGuestSshTrust(t *testing.T) {
	invalid := validTrustDto()
	invalid.CaKeys = nil

	createDto := dto.CreateBoxDTO{
		Id: "box-1", Image: "alpine:latest", OsUser: "root",
		CpuQuota: 1, MemoryQuota: 1, StorageQuota: 1,
	}
	recoverDto := dto.RecoverBoxDTO{
		OsUser: "root", CpuQuota: 1, MemoryQuota: 1, StorageQuota: 1,
		ErrorReason: "boot failed",
	}

	validator := &DefaultValidator{}
	if err := validator.ValidateStruct(createDto); err != nil {
		t.Fatalf("CreateBoxDTO without trust must validate: %v", err)
	}
	if err := validator.ValidateStruct(recoverDto); err != nil {
		t.Fatalf("RecoverBoxDTO without trust must validate: %v", err)
	}

	createDto.GuestSshTrust = &invalid
	if err := validator.ValidateStruct(createDto); err == nil {
		t.Fatal("CreateBoxDTO must reject an incomplete trust bundle")
	}
	recoverDto.GuestSshTrust = &invalid
	if err := validator.ValidateStruct(recoverDto); err == nil {
		t.Fatal("RecoverBoxDTO must reject an incomplete trust bundle")
	}
}
