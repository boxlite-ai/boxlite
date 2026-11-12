package main

import (
	"context"
	"strings"
	"testing"
)

func TestRunRejectsInvalidArgumentsAndMissingDatabase(t *testing.T) {
	t.Setenv("SECRET_DATABASE_URL", "")
	for _, args := range [][]string{nil, {"unknown"}, {"migrate", "extra"}} {
		if err := run(context.Background(), args); err == nil || !strings.Contains(err.Error(), "usage") {
			t.Errorf("run(%v) = %v; want usage error", args, err)
		}
	}
	if err := run(context.Background(), []string{"migrate"}); err == nil || !strings.Contains(err.Error(), "SECRET_DATABASE_URL") {
		t.Errorf("missing database: %v", err)
	}
}
