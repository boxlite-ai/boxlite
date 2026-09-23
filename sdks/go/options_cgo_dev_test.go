//go:build boxlite_dev

package boxlite

import "testing"

// TestCImagePullOptionsKeepsEachChoiceInItsOwnField checks the Go half of the
// hop into boxlite_options_set_image_pull. The single-field cases are the
// point: swapped fields pass the all-set and none-set cases.
func TestCImagePullOptionsKeepsEachChoiceInItsOwnField(t *testing.T) {
	cases := []struct {
		name                          string
		pull                          ImagePullOptions
		wantAnonymous, wantRevalidate int
	}{
		{name: "neither", pull: ImagePullOptions{}},
		{name: "anonymous only", pull: ImagePullOptions{Anonymous: true}, wantAnonymous: 1},
		{name: "revalidate only", pull: ImagePullOptions{Revalidate: true}, wantRevalidate: 1},
		{name: "both", pull: ImagePullOptions{Anonymous: true, Revalidate: true}, wantAnonymous: 1, wantRevalidate: 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			anonymous, revalidate := cImagePullFieldsForTest(tc.pull)
			if anonymous != tc.wantAnonymous || revalidate != tc.wantRevalidate {
				t.Errorf("C fields = {anonymous: %d, revalidate: %d}, want {anonymous: %d, revalidate: %d}",
					anonymous, revalidate, tc.wantAnonymous, tc.wantRevalidate)
			}
		})
	}
}
