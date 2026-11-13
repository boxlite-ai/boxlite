package encryption

import (
	"context"
	"encoding/base64"
	"strings"
)

// EnvKeyProvider is configured once from SECRET_MASTER_KEY_ID and
// SECRET_MASTER_KEY_BASE64 by the application, not through ambient reads here.
// It is intended for development/staging; production key custody belongs in KMS.
type EnvKeyProvider struct {
	keyID string
	key   [32]byte
}

// NewEnvKeyProvider copies one AES-256 key from canonical padded standard Base64.
// The key ID must start with env:; invalid configuration returns ErrInvalidInput.
// This constructor reads no environment variables and provides no rotation support.
func NewEnvKeyProvider(keyID, encodedKey string) (*EnvKeyProvider, error) {
	if !validKeyID(keyID) || len(encodedKey) != 44 {
		return nil, ErrInvalidInput
	}
	key, err := base64.StdEncoding.Strict().DecodeString(encodedKey)
	defer clear(key)
	if err != nil || len(key) != 32 || base64.StdEncoding.EncodeToString(key) != encodedKey {
		return nil, ErrInvalidInput
	}
	p := &EnvKeyProvider{keyID: keyID}
	copy(p.key[:], key)
	return p, nil
}

func validKeyID(id string) bool {
	if !strings.HasPrefix(id, "env:") || len(id) <= 4 || len(id) > 128 {
		return false
	}
	for _, b := range []byte(id[4:]) {
		if b >= 'a' && b <= 'z' || b >= 'A' && b <= 'Z' || b >= '0' && b <= '9' || b == '.' || b == '_' || b == '-' {
			continue
		}
		return false
	}
	return true
}

// Wrap authenticates the supplied AAD and configured key ID around a 32-byte DEK.
// It returns independent ciphertext and rejects invalid inputs or canceled calls.
func (p *EnvKeyProvider) Wrap(ctx context.Context, dek, aad []byte) (WrappedDEK, error) {
	if err := ctx.Err(); err != nil {
		return WrappedDEK{}, err
	}
	if p == nil || p.keyID == "" || len(dek) != 32 {
		return WrappedDEK{}, ErrInvalidInput
	}
	bound, _ := appendString(append([]byte(nil), aad...), p.keyID)
	sealed, err := seal(p.key[:], dek, bound)
	if err != nil {
		return WrappedDEK{}, err
	}
	if err := ctx.Err(); err != nil {
		return WrappedDEK{}, err
	}
	return WrappedDEK{KeyID: p.keyID, Ciphertext: sealed}, nil
}

// Unwrap returns a caller-owned DEK after authentication. A different key ID returns
// ErrUnknownKey; malformed framing returns ErrInvalidInput; tampering returns
// ErrAuthentication. Cancellation returns the context error without a DEK.
func (p *EnvKeyProvider) Unwrap(ctx context.Context, wrapped WrappedDEK, aad []byte) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if p == nil || p.keyID == "" {
		return nil, ErrInvalidInput
	}
	if wrapped.KeyID != p.keyID {
		return nil, ErrUnknownKey
	}
	if len(wrapped.Ciphertext) != 1+12+32+16 {
		return nil, ErrInvalidInput
	}
	bound, _ := appendString(append([]byte(nil), aad...), p.keyID)
	dek, err := open(p.key[:], wrapped.Ciphertext, bound)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		clear(dek)
		return nil, err
	}
	return dek, nil
}
