// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0-only

package boxlite

import (
	"go/ast"
	"go/parser"
	"go/token"
	"reflect"
	"testing"

	"github.com/boxlite-ai/runner/pkg/api/dto"
)

// TestCreateAppliesSecrets guards the hop that `secretSpecs` alone cannot: a
// pure mapping function test passes whether or not Client.Create actually feeds
// the resulting Secrets into the SDK. A behavioral test cannot see this hop —
// boxlite.BoxOption closes over an unexported config (sdks/go/options.go), so a
// fake runtime receives opaque functions it cannot inspect. The AST source
// check is the strongest available guard, the same technique the repo already
// uses for the Start coupling (TestCreateHasNoFallibleStepAfterStart).
func TestCreateAppliesSecrets(t *testing.T) {
	fileSet := token.NewFileSet()
	parsed, err := parser.ParseFile(fileSet, "client.go", nil, 0)
	if err != nil {
		t.Fatalf("parse client.go: %v", err)
	}

	create := findMethod(parsed, "Client", "Create")
	if create == nil {
		t.Fatal("Client.Create not found in client.go")
	}

	if findCall(create.Body, "boxlite", "WithSecret") == nil {
		t.Fatal("Client.Create no longer calls boxlite.WithSecret; secrets would be dropped")
	}
}

// TestRecoverForwardsSecrets exercises recoverCreateDto, the hand-built
// create request RecoverBox hands to Create: every create-carried field the
// caller supplied, secrets included, must survive the copy or a recovered
// box silently loses it.
//
// TestRecoverUsesRecoverCreateDto guards the wiring hop the behavioral test
// cannot: RecoverBox must route through the pure function, or a hand-rolled
// DTO could drop fields again without any test noticing.
func TestRecoverForwardsSecrets(t *testing.T) {
	networkBlockAll := true
	networkAllowList := "10.0.0.0/8"
	recoverDto := dto.RecoverBoxDTO{
		FromVolumeId: "vol-1",
		OsUser:       "root",
		CpuQuota:     2,
		GpuQuota:     1,
		MemoryQuota:  4,
		StorageQuota: 10,
		Env:          map[string]string{"FOO": "bar"},
		Volumes:      []dto.VolumeDTO{{VolumeId: "vol-1", MountPath: "/data"}},
		Secrets: []dto.SecretDTO{
			{Name: "openai", Value: "sk-test", Hosts: []string{"api.openai.com"}, Placeholder: "<BOXLITE_SECRET:openai>"},
			{Name: "github", Value: "gh-test"},
		},
		NetworkBlockAll:  &networkBlockAll,
		NetworkAllowList: &networkAllowList,
	}

	createDto := recoverCreateDto("box-1", recoverDto)

	if createDto.Id != "box-1" {
		t.Errorf("createDto.Id = %q, want box-1", createDto.Id)
	}
	if createDto.OsUser != recoverDto.OsUser {
		t.Errorf("createDto.OsUser = %q, want %q", createDto.OsUser, recoverDto.OsUser)
	}
	if createDto.CpuQuota != recoverDto.CpuQuota {
		t.Errorf("createDto.CpuQuota = %d, want %d", createDto.CpuQuota, recoverDto.CpuQuota)
	}
	if createDto.GpuQuota != recoverDto.GpuQuota {
		t.Errorf("createDto.GpuQuota = %d, want %d", createDto.GpuQuota, recoverDto.GpuQuota)
	}
	if createDto.MemoryQuota != recoverDto.MemoryQuota {
		t.Errorf("createDto.MemoryQuota = %d, want %d", createDto.MemoryQuota, recoverDto.MemoryQuota)
	}
	if createDto.StorageQuota != recoverDto.StorageQuota {
		t.Errorf("createDto.StorageQuota = %d, want %d", createDto.StorageQuota, recoverDto.StorageQuota)
	}
	if len(createDto.Env) != 1 || createDto.Env["FOO"] != "bar" {
		t.Errorf("createDto.Env = %v, want FOO=bar", createDto.Env)
	}
	if len(createDto.Volumes) != 1 || createDto.Volumes[0] != recoverDto.Volumes[0] {
		t.Errorf("createDto.Volumes = %v, want %v", createDto.Volumes, recoverDto.Volumes)
	}
	if len(createDto.Secrets) != len(recoverDto.Secrets) {
		t.Fatalf("createDto.Secrets has %d entries, want %d", len(createDto.Secrets), len(recoverDto.Secrets))
	}
	for i, secret := range recoverDto.Secrets {
		if !reflect.DeepEqual(createDto.Secrets[i], secret) {
			t.Errorf("createDto.Secrets[%d] = %+v, want %+v", i, createDto.Secrets[i], secret)
		}
	}
	if createDto.NetworkBlockAll == nil || !*createDto.NetworkBlockAll {
		t.Errorf("createDto.NetworkBlockAll = %v, want true", createDto.NetworkBlockAll)
	}
	if createDto.NetworkAllowList == nil || *createDto.NetworkAllowList != networkAllowList {
		t.Errorf("createDto.NetworkAllowList = %v, want %q", createDto.NetworkAllowList, networkAllowList)
	}
	if createDto.FromVolumeId != recoverDto.FromVolumeId {
		t.Errorf("createDto.FromVolumeId = %q, want %q", createDto.FromVolumeId, recoverDto.FromVolumeId)
	}
}

// TestRecoverUsesRecoverCreateDto pins the RecoverBox wiring to the pure
// function under test, so a future hand-rolled create request cannot drop a
// field silently while every behavioral test stays green.
func TestRecoverUsesRecoverCreateDto(t *testing.T) {
	fileSet := token.NewFileSet()
	parsed, err := parser.ParseFile(fileSet, "stubs.go", nil, 0)
	if err != nil {
		t.Fatalf("parse stubs.go: %v", err)
	}

	recoverBox := findMethod(parsed, "Client", "RecoverBox")
	if recoverBox == nil {
		t.Fatal("Client.RecoverBox not found in stubs.go")
	}

	callsRecoverCreateDto := false
	ast.Inspect(recoverBox.Body, func(node ast.Node) bool {
		call, ok := node.(*ast.CallExpr)
		if !ok {
			return true
		}
		if ident, ok := call.Fun.(*ast.Ident); ok && ident.Name == "recoverCreateDto" {
			callsRecoverCreateDto = true
			return false
		}
		return true
	})

	if !callsRecoverCreateDto {
		t.Fatal("Client.RecoverBox no longer routes through recoverCreateDto; a hand-built create request could drop fields")
	}
}
