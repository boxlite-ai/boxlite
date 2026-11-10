//go:build boxlite_dev

package boxlite

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	sdk "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/api/dto"
)

func TestNestedVirtualizationManagedPolicy(t *testing.T) {
	t.Setenv("BOXLITE_EXPERIMENTAL", "nested-virtualization")
	for _, authorized := range []bool{false, true} {
		for _, choice := range []string{"omitted", "false", "true"} {
			t.Run(fmt.Sprintf("authorized=%t/choice=%s", authorized, choice), func(t *testing.T) {
				cfg := ClientConfig{HomeDir: t.TempDir()}
				if authorized {
					cfg.ExperimentalFeatures = "nested-virtualization"
				}
				client, err := NewClient(t.Context(), cfg)
				if err != nil {
					skipOrFailRuntimeStart(t, err)
				}
				request := `{"id":"choice","image":"alpine:latest","skipStart":true,"outboundEnabled":false`
				if choice != "omitted" {
					request += `,"nestedVirtualization":` + choice
				}
				var dto dto.CreateBoxDTO
				if err := json.Unmarshal([]byte(request+`}`), &dto); err != nil {
					t.Fatal(err)
				}
				createdID, _, createErr := client.Create(t.Context(), dto)
				client.Close()
				if choice == "true" && !authorized {
					if createErr == nil || !strings.Contains(createErr.Error(), "BOXLITE_EXPERIMENTAL") {
						t.Fatalf("unauthorized request must fail: %v", createErr)
					}
					return
				}
				if createErr != nil {
					t.Fatal(createErr)
				}

				// Reopening with a different nesting request must reuse the saved box.
				rt, err := sdk.NewRuntime(sdk.WithHomeDir(cfg.HomeDir), sdk.WithRunnerManagedPolicy("nested-virtualization"))
				if err != nil {
					t.Fatal(err)
				}
				defer rt.Close()
				advanced, err := sdk.NewAdvancedBoxOptions()
				if err != nil {
					t.Fatal(err)
				}
				defer advanced.Close()
				if err := advanced.SetRunnerNestedVirtualization(true); err != nil {
					t.Fatal(err)
				}
				box, created, err := rt.GetOrCreate(t.Context(), dto.Image, sdk.WithName(dto.Id), sdk.WithAdvancedOptions(advanced))
				if err != nil {
					t.Fatal(err)
				}
				defer box.Close()
				if created || box.ID() != createdID {
					t.Fatalf("replay must reuse %q, got %q (created=%t)", createdID, box.ID(), created)
				}
			})
		}
	}
}
