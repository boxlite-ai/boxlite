//go:build boxlite_dev

package boxlite

import "testing"

// Runtime.Close can claim a call whose completion is already queued; the drain
// then dispatches it to a callback that no longer owns the call. The REST
// catalog answers each call successfully, so Get's callback receives a detail
// the native side allocated and must free rather than deliver.
func TestImageCallbacksLeaveACallCloseClaimedToItsClaimer(t *testing.T) {
	tests := []struct {
		name string
		late func(*Images) (bool, error)
	}{
		{"Get", func(images *Images) (bool, error) { return lateImageGet(images, "quay.io/acme/app") }},
		{"Remove", func(images *Images) (bool, error) { return lateImageRemove(images, "quay.io/acme/app") }},
		{"Usage", lateImageUsage},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			catalog := newImageCatalog(t)

			delivered, err := test.late(catalog.images(t))
			if err != nil {
				t.Fatalf("%s: %v", test.name, err)
			}

			if delivered {
				t.Fatal("the callback delivered a result for a call Runtime.Close had claimed")
			}
			if got := len(catalog.received()); got != 1 {
				t.Errorf("requests: got %d, want the one call answered", got)
			}
		})
	}
}
