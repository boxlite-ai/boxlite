package encryption

import (
	"context"
	"fmt"
	"reflect"
	"sync/atomic"
	"testing"
)

func TestSealedKeyLength(t *testing.T) {
	sealed, err := seal(make([]byte, 32), []byte("value"), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, size := range []int{0, 16, 24, 31, 33} {
		t.Run(fmt.Sprint(size), func(t *testing.T) {
			key := make([]byte, size)
			if result, err := seal(key, []byte("value"), nil); result != nil || err != ErrInvalidInput {
				t.Fatalf("seal accepted non-AES-256 key: %v", err)
			}
			if result, err := open(key, sealed, nil); result != nil || err != ErrInvalidInput {
				t.Fatalf("open accepted non-AES-256 key: %v", err)
			}
		})
	}
}

// Cancel at a specified cancellation checkpoint, without sleeps or scheduler
// races. The embedded context keeps Done and Err consistent after cancellation.
type checkpointContext struct {
	context.Context
	cancel context.CancelFunc
	checks atomic.Int32
}

func newCheckpointContext(t *testing.T, checks int32) context.Context {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	c := &checkpointContext{Context: ctx, cancel: cancel}
	c.checks.Store(checks)
	return c
}

func (c *checkpointContext) Err() error {
	if c.checks.Add(-1) == 0 {
		c.cancel()
	}
	return c.Context.Err()
}

func TestCancellationAfterCrypto(t *testing.T) {
	p := fixtureProvider(t, "env:v1", 1)
	identity := fixtureContext()
	c := fixtureCipher(t, p)
	envelope := encryptFixture(t, c, identity, []byte("value"))
	_, aad, err := identity.aad()
	if err != nil {
		t.Fatal(err)
	}
	t.Run("wrap", func(t *testing.T) {
		// Wrap checks cancellation at entry and after sealing the DEK.
		result, err := p.Wrap(newCheckpointContext(t, 2), make([]byte, 32), aad)
		if err != context.Canceled || !reflect.DeepEqual(result, WrappedDEK{}) {
			t.Fatalf("released wrapped DEK after cancellation: %v", err)
		}
	})
	t.Run("unwrap", func(t *testing.T) {
		// Unwrap checks cancellation at entry and after opening the DEK.
		result, err := p.Unwrap(newCheckpointContext(t, 2), envelope.WrappedDEK, aad)
		if err != context.Canceled || result != nil {
			t.Fatalf("released DEK after cancellation: %v", err)
		}
	})
	t.Run("decrypt", func(t *testing.T) {
		// Isolate Cipher's three checkpoints from the provider's checks while
		// still obtaining the DEK through real authenticated unwrapping.
		provider := testProvider{unwrap: func(_ context.Context, wrapped WrappedDEK, aad []byte) ([]byte, error) {
			return p.Unwrap(context.Background(), wrapped, aad)
		}}
		result, err := fixtureCipher(t, provider).Decrypt(newCheckpointContext(t, 3), identity, envelope)
		if err != context.Canceled || result != nil {
			t.Fatalf("released plaintext after cancellation: %v", err)
		}
	})
}
