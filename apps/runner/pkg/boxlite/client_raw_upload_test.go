package boxlite

import "testing"

func TestRawUploadCommandWritesRequestedGuestPath(t *testing.T) {
	command, args, err := rawUploadCommand("/tmp/fc-hydrate.tar")
	if err != nil {
		t.Fatalf("rawUploadCommand: %v", err)
	}
	if command != "sh" {
		t.Fatalf("command = %q, want sh", command)
	}
	want := []string{
		"-c",
		`mkdir -p "$1" && cat > "$2"`,
		"boxlite-raw-upload",
		"/tmp",
		"/tmp/fc-hydrate.tar",
	}
	if len(args) != len(want) {
		t.Fatalf("args len = %d, want %d: %#v", len(args), len(want), args)
	}
	for i := range want {
		if args[i] != want[i] {
			t.Fatalf("args[%d] = %q, want %q", i, args[i], want[i])
		}
	}
}

func TestRawUploadCommandRejectsEmptyDestination(t *testing.T) {
	if _, _, err := rawUploadCommand(""); err == nil {
		t.Fatalf("rawUploadCommand accepted empty destination")
	}
}
