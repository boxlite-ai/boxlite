package boxlite

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestSnapshotNativeContract(t *testing.T) {
	runtime, err := NewRuntime(WithHomeDir(t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	box, err := runtime.Create(ctx, "alpine:3.23", WithAutoRemove(false))
	if err != nil {
		t.Fatal(err)
	}
	defer box.Close()
	snapshots := box.Snapshots()
	infos, err := snapshots.List(ctx)
	if err != nil || len(infos) != 0 {
		t.Fatalf("initial snapshots: %v, %v", infos, err)
	}
	for _, test := range []struct {
		kind string
		code ErrorCode
	}{
		{"memory", ErrUnsupported}, {"unknown", ErrInvalidArgument},
	} {
		_, err := snapshots.Create(ctx, "s", test.kind)
		var native *Error
		if !errors.As(err, &native) || native.Code != test.code {
			t.Fatalf("%s: %v", test.kind, err)
		}
	}
	if _, err := snapshots.Get(ctx, "missing"); !IsNotFound(err) {
		t.Fatalf("lookup: %v", err)
	}
	canceled, stop := context.WithCancel(ctx)
	stop()
	if _, err := snapshots.Create(canceled, "canceled", "filesystem"); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel: %v", err)
	}
	infos, err = snapshots.List(ctx)
	if err != nil || len(infos) != 0 {
		t.Fatalf("failed requests mutated snapshots: %v, %v", infos, err)
	}
}
