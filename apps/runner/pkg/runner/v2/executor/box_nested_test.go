package executor

import (
	"context"
	"testing"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
)

type nestingStartBackend struct {
	*fakeBackend
	requested bool
}

func (b *nestingStartBackend) Start(_ context.Context, _ string, _ *string, _ map[string]string, nested bool) (string, error) {
	b.requested = nested
	return "boxlite", nil
}

func TestNestedVirtualizationStartJob(t *testing.T) {
	for _, payload := range []string{`{}`, `{"nestedVirtualization":false}`, `{"nestedVirtualization":true}`} {
		t.Run(payload, func(t *testing.T) {
			backend := &nestingStartBackend{fakeBackend: &fakeBackend{}}
			executor := &Executor{backend: backend}
			job := &apiclient.Job{ResourceId: "box", Payload: &payload}
			if _, err := executor.startBox(t.Context(), job); err != nil {
				t.Fatal(err)
			}
			if want := payload == `{"nestedVirtualization":true}`; backend.requested != want {
				t.Fatalf("backend nesting = %t, want %t", backend.requested, want)
			}
		})
	}
}
