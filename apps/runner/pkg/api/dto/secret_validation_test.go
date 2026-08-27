// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0-only

package dto

import (
	"strings"
	"testing"

	"github.com/go-playground/validator/v10"
)

// newBoundaryValidator mirrors api.DefaultValidator.lazyinit (tag name
// "validate", WithRequiredStructEnabled) — the validator gin uses to bind
// request bodies.
func newBoundaryValidator() *validator.Validate {
	v := validator.New(validator.WithRequiredStructEnabled())
	v.SetTagName("validate")
	return v
}

// The dive tags on CreateBoxDTO.Secrets / RecoverBoxDTO.Secrets are what make
// the validator descend into each element; without them SecretDTO's required
// tags are dead and an empty name or value reaches the SDK.
func TestSecretFieldsValidatePerElement(t *testing.T) {
	v := newBoundaryValidator()

	valid := CreateBoxDTO{
		Id:           "box-1",
		Image:        "alpine:latest",
		OsUser:       "root",
		CpuQuota:     1,
		MemoryQuota:  1,
		StorageQuota: 1,
		Secrets:      []SecretDTO{{Name: "openai", Value: "sk-test"}},
	}
	if err := v.Struct(valid); err != nil {
		t.Fatalf("a well-formed secret must validate, got: %v", err)
	}

	create := func(secret SecretDTO) CreateBoxDTO {
		createDto := valid
		createDto.Secrets = []SecretDTO{secret}
		return createDto
	}
	recover := func(secret SecretDTO) RecoverBoxDTO {
		return RecoverBoxDTO{
			FromVolumeId: "vol-1",
			OsUser:       "root",
			CpuQuota:     1,
			MemoryQuota:  1,
			StorageQuota: 1,
			ErrorReason:  "recover",
			Secrets:      []SecretDTO{secret},
		}
	}

	for _, tt := range []struct {
		name string
		box  any
	}{
		{"create rejects an empty secret name", create(SecretDTO{Name: "", Value: "v"})},
		{"create rejects an empty secret value", create(SecretDTO{Name: "n", Value: ""})},
		{"recover rejects an empty secret name", recover(SecretDTO{Name: "", Value: "v"})},
		{"recover rejects an empty secret value", recover(SecretDTO{Name: "n", Value: ""})},
	} {
		err := v.Struct(tt.box)
		if err == nil {
			t.Errorf("%s: empty secret field was accepted", tt.name)
			continue
		}
		// The failure must come from the nested element, not an unrelated
		// top-level field — otherwise this test is green for the wrong reason.
		if !strings.Contains(err.Error(), "Secrets[0]") {
			t.Errorf("%s: validation failed for the wrong reason: %v", tt.name, err)
		}
	}
}
