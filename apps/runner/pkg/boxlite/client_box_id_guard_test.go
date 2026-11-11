// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package boxlite

import (
	"context"
	"strings"
	"testing"

	"github.com/boxlite-ai/runner/pkg/api/dto"
)

// The box id becomes part of filesystem paths: volume mount records
// ({id}.json) and the runtime's own box name. These tests pin the boundary
// guards on Create/Start/Destroy —
// a traversal-shaped id is rejected before any mount or record work runs.
//
// createDtoWithUnknownFilestore carries a filestore volume naming an
// instance that is not in the registry: once an id passes the guard,
// getVolumeMounts fails with the instance-lookup error instead, which is
// what distinguishes "the guard rejected it" from "the call got into mount
// work".
func createDtoWithUnknownFilestore(id string) dto.CreateBoxDTO {
	outbound := true
	return dto.CreateBoxDTO{
		Id:              id,
		OutboundEnabled: &outbound,
		Volumes: []dto.VolumeDTO{
			// A well-formed volume id: the helper probes the later failure
			// (unknown instance), so the volume id guard must admit it.
			{VolumeId: "vol-probe", Filestore: &dto.FilestoreRef{Instance: "not-in-registry"}},
		},
	}
}

func TestCreateRejectsTraversalShapedBoxId(t *testing.T) {
	c := testClient(t)

	for _, id := range []string{"bad/id", "bad\\id", "../etc", "box..id"} {
		_, _, err := c.Create(context.Background(), createDtoWithUnknownFilestore(id))
		if err == nil {
			t.Fatalf("Create with id %q: expected the box id guard to reject it, got nil", id)
		}
		if !strings.Contains(err.Error(), "invalid box id") {
			t.Fatalf("Create with id %q: expected the box id guard error, got %q", id, err)
		}
		if strings.Contains(err.Error(), "unknown Filestore instance") {
			t.Fatalf("Create with id %q: reached volume mount work (instance lookup) although the guard should have rejected it", id)
		}
	}
}

func TestCreateAdmitsWellFormedBoxId(t *testing.T) {
	c := testClient(t)

	// A registry-conforming id passes the guard, so the failure must come
	// from the later mount work — here the unknown filestore instance. That
	// contrast is what proves the guard is what rejected the ids above.
	_, _, err := c.Create(context.Background(), createDtoWithUnknownFilestore("abc123def456"))
	if err == nil {
		t.Fatal("expected the unknown-instance error once the guard admits the id, got nil")
	}
	if !strings.Contains(err.Error(), "unknown Filestore instance") {
		t.Fatalf("expected the unknown-instance error after the guard admitted the id, got %q", err)
	}
}

func TestStartAndDestroyRejectTraversalShapedBoxId(t *testing.T) {
	c := testClient(t)

	_, startErr := c.Start(context.Background(), "../esc", nil, nil)
	if startErr == nil || !strings.Contains(startErr.Error(), "invalid box id") {
		t.Fatalf("Start with traversal id: expected the box id guard error, got %v", startErr)
	}

	destroyErr := c.Destroy(context.Background(), "bad/id")
	if destroyErr == nil || !strings.Contains(destroyErr.Error(), "invalid box id") {
		t.Fatalf("Destroy with traversal id: expected the box id guard error, got %v", destroyErr)
	}
}
