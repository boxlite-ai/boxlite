// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package config

import (
	"maps"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadProxyAPIKey(t *testing.T) {
	t.Run("direct value remains supported", func(t *testing.T) {
		got, err := loadProxyAPIKey("inline-key", "")
		if err != nil {
			t.Fatal(err)
		}
		if got != "inline-key" {
			t.Fatalf("loadProxyAPIKey() = %q, want inline-key", got)
		}
	})

	t.Run("mounted file is read and its line ending is removed", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "proxy-api-key")
		if err := os.WriteFile(path, []byte("file-key\r\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		got, err := loadProxyAPIKey("", path)
		if err != nil {
			t.Fatal(err)
		}
		if got != "file-key" {
			t.Fatalf("loadProxyAPIKey() = %q, want file-key", got)
		}
	})

	t.Run("spaces are secret bytes, not formatting", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "proxy-api-key")
		if err := os.WriteFile(path, []byte(" key with spaces "), 0o600); err != nil {
			t.Fatal(err)
		}
		got, err := loadProxyAPIKey("", path)
		if err != nil {
			t.Fatal(err)
		}
		if got != " key with spaces " {
			t.Fatalf("loadProxyAPIKey() = %q, want spaces preserved", got)
		}
	})

	for _, tc := range []struct {
		name  string
		value string
		path  string
		want  string
	}{
		{name: "both channels", value: "inline", path: "/secret", want: "mutually exclusive"},
		{name: "neither channel", want: "one of PROXY_API_KEY or PROXY_API_KEY_FILE is required"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := loadProxyAPIKey(tc.value, tc.path)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("loadProxyAPIKey() error = %v, want text %q", err, tc.want)
			}
		})
	}

	t.Run("read failure names the file and preserves the cause", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "missing")
		_, err := loadProxyAPIKey("", path)
		if err == nil || !strings.Contains(err.Error(), path) || !os.IsNotExist(err) {
			t.Fatalf("loadProxyAPIKey() error = %v, want path and not-exist cause", err)
		}
	})

	t.Run("empty mounted file is rejected", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "proxy-api-key")
		if err := os.WriteFile(path, nil, 0o600); err != nil {
			t.Fatal(err)
		}
		_, err := loadProxyAPIKey("", path)
		if err == nil || !strings.Contains(err.Error(), "is empty") {
			t.Fatalf("loadProxyAPIKey() error = %v, want empty-file refusal", err)
		}
	})
}

func TestGetOtelHeaders(t *testing.T) {
	cases := []struct {
		name    string
		headers string
		want    map[string]string
	}{
		{"empty", "", map[string]string{}},
		{"single pair", "authorization=Bearer abc", map[string]string{"authorization": "Bearer abc"}},
		{"multiple pairs", "a=1,b=2", map[string]string{"a": "1", "b": "2"}},
		{"whitespace trimmed", " a = 1 , b = 2 ", map[string]string{"a": "1", "b": "2"}},
		{"malformed pair skipped", "a=1,broken,b=2", map[string]string{"a": "1", "b": "2"}},
		{"value keeps extra equals", "a=x=y", map[string]string{"a": "x=y"}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := &Config{OtelHeaders: tc.headers}
			got := c.GetOtelHeaders()
			if !maps.Equal(got, tc.want) {
				t.Errorf("GetOtelHeaders(%q) = %v, want %v", tc.headers, got, tc.want)
			}
		})
	}
}
