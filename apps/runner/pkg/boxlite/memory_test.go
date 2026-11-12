package boxlite

import (
	"context"
	"encoding/json"
	"log/slog"
	"testing"

	"github.com/boxlite-ai/runner/pkg/api/dto"
	"github.com/containerd/errdefs"
)

func TestInvalidMemoryBeforeRuntime(t *testing.T) {
	for _, operation := range []string{"create", "recover"} {
		t.Run(operation, func(t *testing.T) {
			client := &Client{logger: slog.Default()}
			raw := []byte(`{"memoryQuota":-1,"outboundEnabled":true}`)
			var create dto.CreateBoxDTO
			var recovery dto.RecoverBoxDTO
			if err := json.Unmarshal(raw, &create); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal(raw, &recovery); err != nil {
				t.Fatal(err)
			}
			defer func() {
				if p := recover(); p != nil {
					t.Fatalf("invalid memory reached runtime side effects: %v", p)
				}
			}()
			var err error
			if operation == "create" {
				_, _, err = client.Create(context.Background(), create)
			} else {
				err = client.RecoverBox(context.Background(), "existing", recovery)
			}
			if !errdefs.IsInvalidArgument(err) {
				t.Fatalf("expected invalid memory error, got %v", err)
			}
		})
	}
}
