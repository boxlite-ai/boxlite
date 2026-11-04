package privilege

import (
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
)

// ReleasePublicKey is the base64 ed25519 key that signs supervisor releases
// (cmd/releasesign). It is compiled in with -ldflags -X; dev and test builds
// leave it empty and skip the check. The private key never leaves the build
// machine, so a compromised control plane cannot get the launcher to run a
// binary of its own.
var ReleasePublicKey string

// ErrBadSignature means a downloaded supervisor was not signed by the release key.
var ErrBadSignature = errors.New("supervisor download is not signed by the release key")

// VerifyRelease checks sigB64 (from <binary>.sig) against the SHA-256 digest of
// the downloaded binary.
func VerifyRelease(pubB64 string, digest []byte, sigB64 string) error {
	pub, err := base64.StdEncoding.DecodeString(strings.TrimSpace(pubB64))
	if err != nil || len(pub) != ed25519.PublicKeySize {
		return fmt.Errorf("release public key is malformed: %w", ErrBadSignature)
	}
	sig, err := base64.StdEncoding.DecodeString(strings.TrimSpace(sigB64))
	if err != nil || len(sig) != ed25519.SignatureSize {
		return fmt.Errorf("signature is malformed: %w", ErrBadSignature)
	}
	if !ed25519.Verify(ed25519.PublicKey(pub), digest, sig) {
		return ErrBadSignature
	}
	return nil
}
