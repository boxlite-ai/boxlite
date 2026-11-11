// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package boxlite

import (
	"encoding/json"
	"strings"
	"testing"

	sdk "github.com/boxlite-ai/boxlite/sdks/go"
)

func TestCheckpointImportOptionsOwnCloudIdentityAndPinnedImage(t *testing.T) {
	image := "example/app:old@sha256:" + strings.Repeat("a", 64)
	env := map[string]string{"BOXLITE_BOX_ID": "target", "BOXLITE_ORGANIZATION_ID": "org"}
	options, err := checkpointImportOptions(image, env)
	if err != nil {
		t.Fatal(err)
	}
	if options.Image != "example/app@sha256:"+strings.Repeat("a", 64) || !options.PreflightStartup {
		t.Fatalf("checkpoint lost pinned startup preflight: %#v", options)
	}
	if len(options.Env) != len(checkpointPlatformEnvKeys) {
		t.Fatal("source identity keys were not cleared")
	}
	for _, key := range checkpointPlatformEnvKeys {
		value := options.Env[key]
		if expected, supplied := env[key]; supplied {
			if value == nil || *value != expected {
				t.Fatalf("target identity %s was not set", key)
			}
		} else if value != nil {
			t.Fatalf("source identity %s was inherited", key)
		}
	}
	for _, candidate := range []map[string]string{
		{}, {"BOXLITE_BOX_ID": "target", "USER_CONFIG": "override"},
		{"BOXLITE_BOX_ID": "target\x00invalid"},
	} {
		if _, err := checkpointImportOptions(image, candidate); err == nil {
			t.Fatal("invalid platform environment accepted")
		}
	}
	if _, err := checkpointImportOptions("example/app:moved", env); err == nil {
		t.Fatal("mutable image accepted")
	}
}

func TestCheckpointArchivePolicyRejectsSourceHostDependencies(t *testing.T) {
	for _, scenario := range []string{"valid", "legacy", "missing-options", "missing-checksum", "rootfs", "volumes", "mounts", "secrets", "invalid-json"} {
		t.Run(scenario, func(t *testing.T) {
			options := map[string]any{"rootfs": map[string]string{"Image": "example/app:source"}}
			info := sdk.ImportArchiveInfo{Version: 3, HasDiskChecksum: true}
			switch scenario {
			case "legacy":
				info.Version = 2
			case "missing-checksum":
				info.HasDiskChecksum = false
			case "rootfs":
				options["rootfs"] = map[string]string{"RootfsPath": "/host/rootfs"}
			case "volumes", "mounts", "secrets":
				options[scenario] = []any{map[string]string{"source": "/host"}}
			}
			var err error
			info.BoxOptions, err = json.Marshal(options)
			if err != nil {
				t.Fatal(err)
			}
			if scenario == "missing-options" {
				info.BoxOptions = json.RawMessage("null")
			}
			if scenario == "invalid-json" {
				info.BoxOptions = json.RawMessage("{")
			}
			err = validateCheckpointArchive(info)
			if (err == nil) != (scenario == "valid") {
				t.Fatalf("source policy: %v", err)
			}
		})
	}
}
