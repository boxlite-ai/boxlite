package privilege

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"testing"
)

func TestVerifyRelease(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	pubB64 := base64.StdEncoding.EncodeToString(pub)
	digest := sha256.Sum256([]byte("supervisor binary"))
	sig := base64.StdEncoding.EncodeToString(ed25519.Sign(priv, digest[:]))
	if err := VerifyRelease(pubB64, digest[:], sig+"\n"); err != nil {
		t.Fatalf("a valid signature was refused: %v", err)
	}
	other := sha256.Sum256([]byte("tampered binary"))
	if err := VerifyRelease(pubB64, other[:], sig); !errors.Is(err, ErrBadSignature) {
		t.Fatalf("a tampered binary passed: %v", err)
	}
	_, otherPriv, _ := ed25519.GenerateKey(rand.Reader)
	forged := base64.StdEncoding.EncodeToString(ed25519.Sign(otherPriv, digest[:]))
	if err := VerifyRelease(pubB64, digest[:], forged); !errors.Is(err, ErrBadSignature) {
		t.Fatalf("a signature by another key passed: %v", err)
	}
	if err := VerifyRelease(pubB64, digest[:], "not base64!"); !errors.Is(err, ErrBadSignature) {
		t.Fatalf("garbage passed: %v", err)
	}
}
