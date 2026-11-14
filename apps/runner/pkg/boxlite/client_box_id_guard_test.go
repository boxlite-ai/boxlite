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
// createDtoWithBadVolumeId carries a filestore volume whose volume id is
// traversal-shaped: once an id passes the guard, getVolumeMounts fails with
// the volume-id guard error instead, which is what distinguishes "the guard
// rejected it" from "the call got into mount work".
func createDtoWithBadVolumeId(id string) dto.CreateBoxDTO {
	outbound := true
	return dto.CreateBoxDTO{
		Id:              id,
		OutboundEnabled: &outbound,
		Volumes: []dto.VolumeDTO{
			// A traversal-shaped volume id: the volume-id guard fails it after
			// the box-id guard admits the id.
			{VolumeId: "../escape", Filestore: &dto.FilestoreRef{Instance: "ml", Server: "10.0.0.7", Export: "/vol1"}},
		},
	}
}

func TestCreateRejectsTraversalShapedBoxId(t *testing.T) {
	c := testClient(t)

	for _, id := range []string{"bad/id", "bad\\id", "../etc", "box..id"} {
		_, _, err := c.Create(context.Background(), createDtoWithBadVolumeId(id))
		if err == nil {
			t.Fatalf("Create with id %q: expected the box id guard to reject it, got nil", id)
		}
		if !strings.Contains(err.Error(), "invalid box id") {
			t.Fatalf("Create with id %q: expected the box id guard error, got %q", id, err)
		}
		if strings.Contains(err.Error(), "invalid filestore volume id") {
			t.Fatalf("Create with id %q: reached volume mount work (volume id guard) although the box-id guard should have rejected it", id)
		}
	}
}

func TestCreateAdmitsWellFormedBoxId(t *testing.T) {
	// The rollback on getVolumeMounts failure removes the box's record file,
	// which resolves the mount base path — without the override that reaches
	// the config package global, which no test initializes. The override keeps
	// the test hermetic; the guard assertions below are untouched.
	useVolumeMountBasePath(t, t.TempDir())
	c := testClient(t)

	// A well-formed box id passes the guard, so the failure must come from
	// the later mount work — here the volume-id guard. That contrast is what
	// proves the guard is what rejected the ids above.
	_, _, err := c.Create(context.Background(), createDtoWithBadVolumeId("abc123def456"))
	if err == nil {
		t.Fatal("expected the volume-id guard error once the guard admits the id, got nil")
	}
	if !strings.Contains(err.Error(), "invalid filestore volume id") {
		t.Fatalf("expected the volume-id guard error after the guard admitted the id, got %q", err)
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
