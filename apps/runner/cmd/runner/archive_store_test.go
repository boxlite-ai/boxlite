// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package main

import (
	"io"
	"log/slog"
	"testing"

	"github.com/boxlite-ai/runner/cmd/runner/config"
	"github.com/boxlite-ai/runner/pkg/storage"
)

func TestArchiveStoreFactoryKeepsGCSIndependentFromS3(t *testing.T) {
	for name, cfg := range map[string]*config.Config{
		"S3 absent":    {},
		"S3 invalid":   {AWSDefaultBucket: "archives"},
		"S3 available": {AWSDefaultBucket: "archives", AWSRegion: "us-east-1"},
	} {
		t.Run(name, func(t *testing.T) {
			store := archiveStore(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
			scheme, ok := store.(*storage.SchemeArchiveStore)
			if !ok || scheme.GCS == nil {
				t.Fatalf("factory did not configure GCS: %T", store)
			}
			if err := scheme.Check("gs://archives/box.boxlite"); err != nil {
				t.Fatal(err)
			}
			if err := scheme.Check("s3://archives/box.boxlite"); (err == nil) != (name == "S3 available") {
				t.Fatalf("S3 availability = %v", err)
			}
		})
	}
}
