// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package config

import (
	"fmt"
	"reflect"
	"strings"
	"testing"
)

// FILESTORE_INSTANCES is the runner's opt-in registry of Filestore instances
// it may mount. Every failure below is a deployment mistake that would
// otherwise surface as a mystery at first box create, so the parser must
// reject it here — where the runner refuses to start — rather than let a
// half-usable registry through.
func TestParseFilestoreInstances(t *testing.T) {
	// The longest name the pattern allows: one leading character plus the
	// pattern's own 62-character remainder, pinned here so a change to the
	// pattern's bound shows up as a test edit, not as a surprise.
	longestAllowed := "a" + strings.Repeat("-", 62)

	for _, tc := range []struct {
		name string
		raw  string
		// want is the parsed result. Cases expecting an error leave it nil.
		want []FilestoreInstance
		// wantNil pins that the returned slice is the nil slice itself, not
		// merely empty — the registry's "unset" state is nil.
		wantNil bool
		// wantErr lists substrings every one of which must appear in the
		// error; empty means the input must parse.
		wantErr []string
	}{
		{
			name:    "an empty value means no instances and is not an error",
			raw:     "",
			wantNil: true,
		},
		{
			name: "whitespace only is also unset",
			raw:  "   ",
			// The parser trims before deciding; nil-ness is not pinned here so
			// the case stays about "no instances", not about slice identity.
		},
		{
			name: "a single instance parses with its address",
			raw:  `[{"name":"ml-scratch","server":"10.0.0.7","export":"/vol1"}]`,
			want: []FilestoreInstance{{Name: "ml-scratch", Server: "10.0.0.7", Export: "/vol1"}},
		},
		{
			name: "mountOptions ride along on every entry",
			raw: `[{"name":"a","server":"10.0.0.1","export":"/vol1","mountOptions":["ro"]},` +
				`{"name":"b","server":"10.0.0.2","export":"/vol2","mountOptions":["ro"]}]`,
			want: []FilestoreInstance{
				{Name: "a", Server: "10.0.0.1", Export: "/vol1", MountOptions: []string{"ro"}},
				{Name: "b", Server: "10.0.0.2", Export: "/vol2", MountOptions: []string{"ro"}},
			},
		},
		{
			// Performance-tuning options the pinned argv does not speak to are
			// the intended use of mountOptions, so they parse through.
			name: "benign performance mountOptions ride along too",
			raw:  `[{"name":"a","server":"10.0.0.1","export":"/vol1","mountOptions":["rsize=1048576"]}]`,
			want: []FilestoreInstance{
				{Name: "a", Server: "10.0.0.1", Export: "/vol1", MountOptions: []string{"rsize=1048576"}},
			},
		},
		// The protocol version and retry posture are design-pinned (NFSv4.1,
		// hard), and mount(8) lets a later duplicate option override an earlier
		// one — so a registry entry carrying any of these would silently
		// unpin the argv. Each spelling of each pinned knob must be refused.
		{
			name:    "a pinned vers mount option is rejected",
			raw:     `[{"name":"a","server":"10.0.0.1","export":"/v","mountOptions":["vers=3"]}]`,
			wantErr: []string{"pinned mount option", "vers=3"},
		},
		{
			name:    "a pinned nfsvers mount option is rejected",
			raw:     `[{"name":"a","server":"10.0.0.1","export":"/v","mountOptions":["nfsvers=4.1"]}]`,
			wantErr: []string{"pinned mount option", "nfsvers=4.1"},
		},
		{
			name:    "a pinned proto mount option is rejected",
			raw:     `[{"name":"a","server":"10.0.0.1","export":"/v","mountOptions":["proto=udp"]}]`,
			wantErr: []string{"pinned mount option", "proto=udp"},
		},
		{
			name:    "a pinned soft mount option is rejected",
			raw:     `[{"name":"a","server":"10.0.0.1","export":"/v","mountOptions":["soft"]}]`,
			wantErr: []string{"pinned mount option", "soft"},
		},
		{
			name:    "a pinned hard mount option is rejected",
			raw:     `[{"name":"a","server":"10.0.0.1","export":"/v","mountOptions":["hard"]}]`,
			wantErr: []string{"pinned mount option", "hard"},
		},
		{
			name: "an empty array is still no instances",
			raw:  "[]",
		},
		{
			name:    "truncated JSON names the variable",
			raw:     `[{"name": "a"`,
			wantErr: []string{"FILESTORE_INSTANCES"},
		},
		{
			// The mount point is keyed by name, so two entries with one name
			// would alias two instances onto one host path.
			name: "a duplicate name is rejected",
			raw: `[{"name":"dup","server":"10.0.0.1","export":"/v"},` +
				`{"name":"dup","server":"10.0.0.2","export":"/v"}]`,
			wantErr: []string{"more than once", "dup"},
		},
		{
			name:    "an uppercase name is rejected",
			raw:     `[{"name":"ML","server":"10.0.0.1","export":"/v"}]`,
			wantErr: []string{"invalid name", "ML"},
		},
		{
			name:    "a leading dash is rejected",
			raw:     `[{"name":"-lead","server":"10.0.0.1","export":"/v"}]`,
			wantErr: []string{"invalid name", "-lead"},
		},
		{
			name:    "a slash would carry a path separator into the mount path",
			raw:     `[{"name":"a/b","server":"10.0.0.1","export":"/v"}]`,
			wantErr: []string{"invalid name", "a/b"},
		},
		{
			name:    "dots would carry a relative component into the mount path",
			raw:     `[{"name":"a..b","server":"10.0.0.1","export":"/v"}]`,
			wantErr: []string{"invalid name", "a..b"},
		},
		{
			name:    "an empty name is rejected",
			raw:     `[{"name":"","server":"10.0.0.1","export":"/v"}]`,
			wantErr: []string{"invalid name"},
		},
		{
			name: "short, dash-bearing, digit-leading and maximal names are accepted",
			raw: fmt.Sprintf(`[{"name":"a","server":"10.0.0.1","export":"/v"},`+
				`{"name":"a-b","server":"10.0.0.2","export":"/v"},`+
				`{"name":"0inst","server":"10.0.0.3","export":"/v"},`+
				`{"name":%q,"server":"10.0.0.4","export":"/v"}]`, longestAllowed),
			want: []FilestoreInstance{
				{Name: "a", Server: "10.0.0.1", Export: "/v"},
				{Name: "a-b", Server: "10.0.0.2", Export: "/v"},
				{Name: "0inst", Server: "10.0.0.3", Export: "/v"},
				{Name: longestAllowed, Server: "10.0.0.4", Export: "/v"},
			},
		},
		{
			// A nameless address would produce an unresolvable mount; the error
			// must say which entry is broken.
			name:    "an instance with no server is rejected by name",
			raw:     `[{"name":"noserver","server":"","export":"/v"}]`,
			wantErr: []string{"noserver"},
		},
		{
			name:    "an instance with no export is rejected by name",
			raw:     `[{"name":"noexport","server":"10.0.0.1","export":""}]`,
			wantErr: []string{"noexport"},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ParseFilestoreInstances(tc.raw)

			if len(tc.wantErr) > 0 {
				if err == nil {
					t.Fatalf("ParseFilestoreInstances(%q) succeeded, want error mentioning %v", tc.raw, tc.wantErr)
				}
				for _, want := range tc.wantErr {
					if !strings.Contains(err.Error(), want) {
						t.Errorf("error %q must mention %q", err, want)
					}
				}
				return
			}

			if err != nil {
				t.Fatalf("ParseFilestoreInstances(%q) failed: %v", tc.raw, err)
			}
			if tc.wantNil && got != nil {
				t.Errorf("an unset FILESTORE_INSTANCES must return the nil slice, got %#v", got)
			}
			if len(got) != len(tc.want) {
				t.Fatalf("parsed %d instances\n got: %#v\nwant: %#v", len(got), got, tc.want)
			}
			for i := range got {
				if !reflect.DeepEqual(got[i], tc.want[i]) {
					t.Errorf("instance %d mismatch\n got: %#v\nwant: %#v", i, got[i], tc.want[i])
				}
			}
		})
	}
}
