// Package encryption protects versioned secret values and their routing policy.
package encryption

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"errors"
)

var (
	ErrInvalidInput        = errors.New("invalid encryption input")
	ErrUnknownKey          = errors.New("unknown encryption key")
	ErrAuthentication      = errors.New("encryption authentication failed")
	ErrProviderUnavailable = errors.New("key provider unavailable")
)

// WrappedDEK contains caller-owned ciphertext and the key that actually wrapped it.
type WrappedDEK struct {
	KeyID      string
	Ciphertext []byte
}

// Envelope maps to ciphertext, encrypted_dek, and key_id in version storage.
type Envelope struct {
	Ciphertext []byte
	WrappedDEK WrappedDEK
}

// KeyProvider wraps only 32-byte DEKs, never secret values. Implementations must
// support concurrent calls, honor cancellation, and neither mutate nor retain
// inputs. Unwrap transfers ownership of its plaintext buffer to the caller.
// Wrap likewise returns a fresh ciphertext buffer, not shared provider state.
// Failures use the package sentinels or context errors; other errors are masked.
type KeyProvider interface {
	Wrap(ctx context.Context, dek, aad []byte) (WrappedDEK, error)
	Unwrap(ctx context.Context, wrapped WrappedDEK, aad []byte) ([]byte, error)
}

// Cipher authenticates version identity and routing policy with each value.
// Construct it with NewCipher; concurrent calls require a concurrency-safe provider.
type Cipher struct{ provider KeyProvider }

// NewCipher rejects a nil provider with ErrInvalidInput. Callers must supply an
// initialized provider; typed nil implementations are responsible for rejecting use.
func NewCipher(provider KeyProvider) (*Cipher, error) {
	if provider == nil {
		return nil, ErrInvalidInput
	}
	return &Cipher{provider: provider}, nil
}

// Encrypt creates a new DEK even when plaintext and identity are unchanged.
// Callers enforce value-size and routing-policy restrictions before calling it.
// Inputs are borrowed for the call; returned buffers belong to the caller.
func (c *Cipher) Encrypt(ctx context.Context, identity SecretContext, plaintext []byte) (Envelope, error) {
	if err := ctx.Err(); err != nil {
		return Envelope{}, err
	}
	valueAAD, dekAAD, err := identity.aad()
	if err != nil {
		return Envelope{}, err
	}
	dek := make([]byte, 32)
	defer clear(dek)
	// Go 1.25 rand.Read fills the buffer or terminates the process.
	rand.Read(dek)
	sealed, err := seal(dek, plaintext, valueAAD)
	if err != nil {
		return Envelope{}, err
	}
	wrapped, err := c.provider.Wrap(ctx, dek, dekAAD)
	if err != nil {
		return Envelope{}, providerError(err)
	}
	if err := ctx.Err(); err != nil {
		return Envelope{}, err
	}
	if wrapped.KeyID == "" || len(wrapped.Ciphertext) == 0 {
		return Envelope{}, ErrProviderUnavailable
	}
	return Envelope{Ciphertext: sealed, WrappedDEK: wrapped}, nil
}

// Decrypt authenticates policy before releasing plaintext. The caller must send
// the same authenticated version metadata to the runner, without rereading it.
// The returned plaintext belongs to the caller; every failure returns nil plaintext.
func (c *Cipher) Decrypt(ctx context.Context, identity SecretContext, envelope Envelope) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	valueAAD, dekAAD, err := identity.aad()
	if err != nil {
		return nil, err
	}
	if !validSealed(envelope.Ciphertext) || envelope.WrappedDEK.KeyID == "" || len(envelope.WrappedDEK.Ciphertext) == 0 {
		return nil, ErrInvalidInput
	}
	dek, err := c.provider.Unwrap(ctx, envelope.WrappedDEK, dekAAD)
	defer clear(dek)
	if err != nil {
		return nil, providerError(err)
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if len(dek) != 32 {
		return nil, ErrProviderUnavailable
	}
	plaintext, err := open(dek, envelope.Ciphertext, valueAAD)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		clear(plaintext)
		return nil, err
	}
	return plaintext, nil
}

func providerError(err error) error {
	for _, known := range []error{context.Canceled, context.DeadlineExceeded, ErrInvalidInput, ErrUnknownKey, ErrAuthentication} {
		if errors.Is(err, known) {
			return known
		}
	}
	return ErrProviderUnavailable
}

func newAEAD(key []byte) (cipher.AEAD, error) {
	if len(key) != 32 {
		return nil, ErrInvalidInput
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, ErrInvalidInput
	}
	return cipher.NewGCMWithRandomNonce(block)
}

// v1 is one format byte followed by the standard library's nonce || ciphertext
// || tag. Its AAD domain includes v1; unknown versions never receive fallback.
func seal(key, plaintext, aad []byte) ([]byte, error) {
	aead, err := newAEAD(key)
	if err != nil {
		return nil, err
	}
	return aead.Seal([]byte{1}, nil, plaintext, aad), nil
}

func validSealed(sealed []byte) bool { return len(sealed) >= 1+12+16 && sealed[0] == 1 }

func open(key, sealed, aad []byte) ([]byte, error) {
	if !validSealed(sealed) {
		return nil, ErrInvalidInput
	}
	aead, err := newAEAD(key)
	if err != nil {
		return nil, err
	}
	plaintext, err := aead.Open(nil, nil, sealed[1:], aad)
	if err != nil {
		return nil, ErrAuthentication
	}
	return plaintext, nil
}
