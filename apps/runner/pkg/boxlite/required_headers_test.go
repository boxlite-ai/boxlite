//go:build boxlite_dev

package boxlite

import (
	"encoding/json"
	"github.com/boxlite-ai/runner/pkg/api/dto"
	"github.com/containerd/errdefs"
	"strings"
	"testing"
)

func TestRequiredHeadersPreflight(t *testing.T) {
	for _, extra := range []string{"", `,"headers":null`, `,"headers":{}`} {
		t.Run(extra, func(t *testing.T) {
			var secret dto.SecretDTO
			if err := json.Unmarshal([]byte(`{"name":"x","value":"token","hosts":["api.test.com"]`+extra+`}`), &secret); err != nil {
				t.Fatal(err)
			}
			err := validateRecreatableSecrets([]dto.SecretDTO{secret})
			if !errdefs.IsInvalidArgument(err) || !strings.Contains(err.Error(), `secret "x" has no headers; recreate the box with headers`) {
				t.Fatalf("invalid configuration passed recovery preflight: %v", err)
			}
		})
	}
}
