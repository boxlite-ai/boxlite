// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0-only

package boxlite

import (
	"encoding/json"
	"testing"

	"github.com/boxlite-ai/runner/pkg/api/dto"
)

func TestRecoverForwardsPrivileged(t *testing.T) {
	for _, test := range []struct {
		name string
		body string
		want bool
	}{
		{"omitted", `{}`, false},
		{"false", `{"privileged":false}`, false},
		{"true", `{"privileged":true}`, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			var request dto.RecoverBoxDTO
			if err := json.Unmarshal([]byte(test.body), &request); err != nil {
				t.Fatal(err)
			}
			created := recoverCreateDto("recover-box", request)
			if created.Privileged != test.want {
				t.Fatalf("recovered Privileged = %v, want %v", created.Privileged, test.want)
			}
		})
	}
}
