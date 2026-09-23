// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0-only

package boxlite

import (
	"testing"

	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/api/dto"
)

// TestImagePullOptionsKeepsEachDecision checks that each of the control
// plane's two pull decisions lands in its own field. The single-field cases
// are the point: swapped fields would pass the both-set and neither-set rows,
// and pull every tenant image with this runner's credentials.
func TestImagePullOptionsKeepsEachDecision(t *testing.T) {
	yes, no := true, false
	cases := []struct {
		name       string
		anonymous  *bool
		revalidate *bool
		want       boxlite.ImagePullOptions
	}{
		{name: "neither sent", want: boxlite.ImagePullOptions{}},
		{name: "anonymous only", anonymous: &yes, want: boxlite.ImagePullOptions{Anonymous: true}},
		{name: "revalidate only", revalidate: &yes, want: boxlite.ImagePullOptions{Revalidate: true}},
		{name: "both sent false", anonymous: &no, revalidate: &no, want: boxlite.ImagePullOptions{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := imagePullOptions(dto.CreateBoxDTO{
				AnonymousImagePull: tc.anonymous,
				ImageRevalidate:    tc.revalidate,
			})
			if got != tc.want {
				t.Errorf("imagePullOptions = %+v, want %+v", got, tc.want)
			}
		})
	}
}
