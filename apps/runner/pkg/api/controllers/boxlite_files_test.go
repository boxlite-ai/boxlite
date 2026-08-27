package controllers

import (
	"testing"

	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
)

// Absent or malformed values mean the client predates the hint → Unknown,
// which relays the body with the guest peeking the archive to decide.
func TestParseSourceIsDir(t *testing.T) {
	cases := []struct {
		raw  string
		want boxlite.CopySourceKind
	}{
		{"", boxlite.CopySourceUnknown},
		{"true", boxlite.CopySourceDir},
		{"false", boxlite.CopySourceFile},
		{"1", boxlite.CopySourceDir},
		{"0", boxlite.CopySourceFile},
		{"bogus", boxlite.CopySourceUnknown},
	}
	for _, c := range cases {
		got := parseSourceIsDir(c.raw)
		if got != c.want {
			t.Errorf("parseSourceIsDir(%q) = %d, want %d", c.raw, got, c.want)
		}
	}
}
