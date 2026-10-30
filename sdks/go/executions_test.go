package boxlite

import (
	"context"
	"errors"
	"testing"
)

func TestExecutionRecoveryRejectsInvalidIDsBeforeNativeCalls(t *testing.T) {
	for _, id := range []string{"", "guest\x00suffix"} {
		for _, attach := range []bool{false, true} {
			var err error
			if attach {
				_, err = (&Box{}).AttachExecution(context.Background(), id, nil)
			} else {
				_, err = (&Box{}).GetExecution(context.Background(), id)
			}
			var typed *Error
			if !errors.As(err, &typed) || typed.Code != ErrInvalidArgument {
				t.Fatalf("recovery(%q, attach=%v) = %v, want invalid argument", id, attach, err)
			}
		}
	}
}

func TestExecutionInventoryRejectsClosedBox(t *testing.T) {
	for _, box := range []*Box{nil, {}} {
		_, err := box.ListExecutions(context.Background())
		var typed *Error
		if !errors.As(err, &typed) || typed.Code != ErrInvalidState {
			t.Fatalf("closed inventory = %v, want invalid state", err)
		}
	}
}
