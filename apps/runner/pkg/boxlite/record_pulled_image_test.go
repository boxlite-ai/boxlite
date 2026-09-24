// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0-only

package boxlite

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"

	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
)

type stubBoxInfo struct {
	info *boxlite.BoxInfo
	err  error
}

func (s stubBoxInfo) Info(context.Context) (*boxlite.BoxInfo, error) { return s.info, s.err }

func newImageReportClient() *Client {
	return &Client{
		logger:              slog.New(slog.NewTextHandler(io.Discard, nil)),
		pendingImageReports: map[string]PulledImage{},
	}
}

// A report is owed only when the started box says what its image resolved to,
// and it stays owed until the sync that delivers it clears it. The two other
// outcomes must owe nothing: a box with no resolved image (booted from a rootfs
// path, imported from an archive, or older than the record) has nothing to
// report, and a start must not fail because its info could not be read.
func TestRecordPulledImageOwesAReportOnlyForAResolvedImage(t *testing.T) {
	t.Run("a resolved image is owed until the sync clears it", func(t *testing.T) {
		client := newImageReportClient()
		client.recordPulledImage(context.Background(), "box-1", stubBoxInfo{info: &boxlite.BoxInfo{
			ResolvedImage: &boxlite.ResolvedImage{ManifestDigest: "sha256:abc", TotalLayerSize: 4096},
		}})

		pulled, owed := client.PendingImageReport("box-1")
		if !owed || pulled != (PulledImage{Digest: "sha256:abc", SizeBytes: 4096}) {
			t.Fatalf("PendingImageReport = %+v, %v; want the resolved digest and size, owed", pulled, owed)
		}

		client.ClearPendingImageReport("box-1")
		if _, owed := client.PendingImageReport("box-1"); owed {
			t.Error("a delivered report must not be owed again")
		}
	})

	t.Run("a box with no resolved image owes nothing", func(t *testing.T) {
		client := newImageReportClient()
		client.recordPulledImage(context.Background(), "box-1", stubBoxInfo{info: &boxlite.BoxInfo{}})

		if _, owed := client.PendingImageReport("box-1"); owed {
			t.Error("a box with no resolved image has nothing to report, so it must owe none")
		}
	})

	t.Run("unreadable info drops the report instead of failing", func(t *testing.T) {
		client := newImageReportClient()
		client.recordPulledImage(context.Background(), "box-1", stubBoxInfo{err: errors.New("box is gone")})

		if _, owed := client.PendingImageReport("box-1"); owed {
			t.Error("info that could not be read must leave no report")
		}
	})
}
