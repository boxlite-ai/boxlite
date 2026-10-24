package envfilter

import (
	"slices"
	"strings"
	"testing"
)

func TestAppStripsPlatformVariables(t *testing.T) {
	in := []string{
		"BOXLITE_BOX_TOKEN=bxt_secret", "BOXLITE_CP_URL=https://cp", "BOXLITE_ENV_ID=env_1",
		"SV_LISTEN=:1", "SUDO_USER=boxlite", "PORT=9", "KEEP_ME=1", "PATH=/secure",
	}
	got := App(in, "/image/bin")
	for _, kv := range got {
		k, _, _ := strings.Cut(kv, "=")
		if k != "KEEP_ME" && k != "PATH" {
			t.Fatalf("%s leaked into the app environment: %v", kv, got)
		}
	}
	if !slices.Contains(got, "KEEP_ME=1") || !slices.Contains(got, "PATH=/image/bin") {
		t.Fatalf("ordinary variables and the Box PATH must survive: %v", got)
	}
	if got := App(nil, ""); !slices.Equal(got, []string{"PATH=" + DefaultPath}) {
		t.Fatalf("PATH must always be set: %v", got)
	}
	if got := App([]string{"PATH=/mine"}, ""); !slices.Equal(got, []string{"PATH=/mine"}) {
		t.Fatalf("without a Box PATH the inherited one is kept: %v", got)
	}
}

func TestOn(t *testing.T) {
	for _, v := range []string{"1", "true", "TRUE", "True", "yes", "on", " on "} {
		if !On(v) {
			t.Errorf("On(%q) = false", v)
		}
	}
	for _, v := range []string{"", "0", "false", "off", "no", "2"} {
		if On(v) {
			t.Errorf("On(%q) = true", v)
		}
	}
}
