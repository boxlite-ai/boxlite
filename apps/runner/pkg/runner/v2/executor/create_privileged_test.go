package executor

import (
	"context"
	"testing"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	"github.com/boxlite-ai/runner/pkg/api/dto"
)

type createRecordingBackend struct {
	fakeBackend
	created *dto.CreateBoxDTO
}

func (b *createRecordingBackend) Create(_ context.Context, options dto.CreateBoxDTO) (string, string, error) {
	b.created = &options
	return options.Id, "test-runtime", nil
}

func TestCreateBoxPreservesGuestPrivilege(t *testing.T) {
	for _, tc := range []struct {
		name       string
		payload    string
		privileged bool
	}{
		{"omitted", `{"id":"create-box","image":"alpine:3.21"}`, false},
		{"false", `{"id":"create-box","image":"alpine:3.21","privileged":false}`, false},
		{"true", `{"id":"create-box","image":"alpine:3.21","privileged":true}`, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			backend := &createRecordingBackend{}
			executor := &Executor{backend: backend}
			if _, err := executor.createBox(context.Background(), &apiclient.Job{Payload: &tc.payload}); err != nil {
				t.Fatal(err)
			}
			if backend.created == nil {
				t.Fatal("CREATE_BOX did not reach the backend")
			}
			if backend.created.Id != "create-box" || backend.created.Privileged != tc.privileged {
				t.Fatalf("backend received id=%q privileged=%t, want id=create-box privileged=%t", backend.created.Id, backend.created.Privileged, tc.privileged)
			}
		})
	}
}
