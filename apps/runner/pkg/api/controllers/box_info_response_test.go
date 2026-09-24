package controllers

import (
	"encoding/json"
	"strings"
	"testing"
)

// The field exists so a caller can tell a command that succeeded from one that
// did not, so `0` has to reach the wire as a value while "not recorded" leaves
// the key out entirely. A plain int with omitempty drops both.
func TestBoxInfoResponseDistinguishesZeroExitCodeFromNone(t *testing.T) {
	zero := 0
	code := 137

	for _, tc := range []struct {
		name     string
		exitCode *int
		want     string
	}{
		{"main command succeeded", &zero, `"exitCode":0`},
		{"main command ended by a signal", &code, `"exitCode":137`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			out, err := json.Marshal(BoxInfoResponse{State: "stopped", ExitCode: tc.exitCode})
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			if got := string(out); !strings.Contains(got, tc.want) {
				t.Fatalf("got %s, want it to contain %s", got, tc.want)
			}
		})
	}

	t.Run("no exit code recorded", func(t *testing.T) {
		out, err := json.Marshal(BoxInfoResponse{State: "stopped"})
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		if strings.Contains(string(out), "exitCode") {
			t.Fatalf("got %s, want no exitCode key at all", out)
		}
	})
}
