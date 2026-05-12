package boxlite

import (
	"reflect"
	"testing"
)

// envMapToFlatPairs is the pure-Go pivot point of ExecutionOptions.Env
// support — it owns the contract that env_pairs lands in the C struct
// as a deterministic, even-length [k0,v0,k1,v1,...] sequence. The C
// side at sdks/c/src/exec/command.rs reads pairs in chunks of two
// and silently drops an odd trailing element, so any drift from the
// "sorted, flat, even-length" shape becomes a silent bug rather than
// a compile error. These cases pin the shape so a future refactor
// can't regress it unnoticed.
func TestEnvMapToFlatPairs(t *testing.T) {
	t.Run("nil yields nil", func(t *testing.T) {
		if got := envMapToFlatPairs(nil); got != nil {
			t.Fatalf("nil env must yield nil pairs, got %v", got)
		}
	})

	t.Run("empty yields nil", func(t *testing.T) {
		if got := envMapToFlatPairs(map[string]string{}); got != nil {
			t.Fatalf("empty env must yield nil pairs, got %v", got)
		}
	})

	t.Run("sorted by key, flat, even length", func(t *testing.T) {
		got := envMapToFlatPairs(map[string]string{
			"PATH":   "/usr/bin",
			"HOME":   "/root",
			"LANG":   "C",
			"DEBUG":  "1",
			"SHLVL":  "1",
			"PWD":    "/",
			"FOO":    "bar",
			"AAA":    "first",
			"ZZZ":    "last",
			"_UNDER": "score",
		})
		// 10 entries -> 20 strings.
		if len(got)%2 != 0 {
			t.Fatalf("flat pairs must have even length, got %d: %v", len(got), got)
		}
		want := []string{
			"AAA", "first",
			"DEBUG", "1",
			"FOO", "bar",
			"HOME", "/root",
			"LANG", "C",
			"PATH", "/usr/bin",
			"PWD", "/",
			"SHLVL", "1",
			"ZZZ", "last",
			"_UNDER", "score",
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("env pairs not in sorted key order\nwant: %v\n got: %v", want, got)
		}
	})

	t.Run("empty value preserved (env=) ", func(t *testing.T) {
		got := envMapToFlatPairs(map[string]string{"EMPTY": ""})
		want := []string{"EMPTY", ""}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("empty-value pair must round-trip, want %v got %v", want, got)
		}
	})
}
