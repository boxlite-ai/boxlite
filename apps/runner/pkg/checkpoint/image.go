// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package checkpoint

import (
	"fmt"
	"strings"
)

// PinImage uses the build recorded for the source disk, never a fresh tag
// lookup. An already pinned reference also works after native archive import.
func PinImage(image, manifestDigest string) (string, error) {
	repository, digest, _ := strings.Cut(image, "@")
	if manifestDigest != "" {
		digest = manifestDigest
	}
	digest, valid := strings.CutPrefix(strings.ToLower(digest), "sha256:")
	if !valid || !sha256Digest(digest) || repository == "" {
		return "", fmt.Errorf("checkpoint source requires a recorded SHA-256 image build or an already pinned image")
	}
	if separator := strings.LastIndex(repository, ":"); separator > strings.LastIndex(repository, "/") {
		repository = repository[:separator]
	}
	return repository + "@sha256:" + digest, nil
}
