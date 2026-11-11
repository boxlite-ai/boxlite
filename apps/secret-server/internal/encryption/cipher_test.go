package encryption

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"maps"
	"reflect"
	"strings"
	"sync"
	"testing"
)

func fixtureContext() SecretContext {
	return SecretContext{
		OrganizationID: "00000000-0000-0000-0000-000000000001",
		SecretID:       "00000000-0000-0000-0000-000000000002", Version: 3,
		Hosts:   []string{"API.example.com", "*.example.net"},
		Headers: map[string]string{"Authorization": "Bearer {value}", "X-Key": "{value}"},
	}
}

func fixtureProvider(t testing.TB, id string, fill byte) *EnvKeyProvider {
	t.Helper()
	p, err := NewEnvKeyProvider(id, base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{fill}, 32)))
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func fixtureCipher(t testing.TB, p KeyProvider) *Cipher {
	t.Helper()
	c, err := NewCipher(p)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func encryptFixture(t testing.TB, c *Cipher, identity SecretContext, value []byte) Envelope {
	t.Helper()
	e, err := c.Encrypt(context.Background(), identity, value)
	if err != nil {
		t.Fatal(err)
	}
	return e
}

func TestRoundTripAndOwnership(t *testing.T) {
	c := fixtureCipher(t, fixtureProvider(t, "env:v1", 1))
	for _, value := range [][]byte{nil, {}, []byte("Unicode: 密钥\x00\xff"), bytes.Repeat([]byte("x"), 8192)} {
		identity := fixtureContext()
		savedHosts, savedHeaders := append([]string(nil), identity.Hosts...), maps.Clone(identity.Headers)
		original := bytes.Clone(value)
		e := encryptFixture(t, c, identity, value)
		if e.WrappedDEK.KeyID != "env:v1" || len(e.WrappedDEK.Ciphertext) != 61 || len(e.Ciphertext) != len(value)+29 {
			t.Fatal("incorrect envelope metadata")
		}
		before := bytes.Clone(e.Ciphertext)
		plain, err := c.Decrypt(context.Background(), identity, e)
		if err != nil || !bytes.Equal(plain, value) {
			t.Fatalf("round trip: %v", err)
		}
		if len(plain) > 0 {
			plain[0] ^= 1
		}
		if !bytes.Equal(e.Ciphertext, before) || !bytes.Equal(value, original) || !reflect.DeepEqual(identity.Hosts, savedHosts) || !maps.Equal(identity.Headers, savedHeaders) {
			t.Fatal("operation mutated caller buffers")
		}
	}
}

func TestPolicyAuthentication(t *testing.T) {
	c := fixtureCipher(t, fixtureProvider(t, "env:v1", 1))
	e := encryptFixture(t, c, fixtureContext(), []byte("fixture-secret"))
	cases := map[string]func(*SecretContext){
		"organization":   func(s *SecretContext) { s.OrganizationID = s.SecretID },
		"secret":         func(s *SecretContext) { s.SecretID = s.OrganizationID },
		"version":        func(s *SecretContext) { s.Version++ },
		"destination":    func(s *SecretContext) { s.Hosts[0] = "attacker.example" },
		"wildcard":       func(s *SecretContext) { s.Hosts[1] = "example.net" },
		"template":       func(s *SecretContext) { s.Headers["Authorization"] = "Bot {value}" },
		"template case":  func(s *SecretContext) { s.Headers["Authorization"] = "bearer {value}" },
		"template space": func(s *SecretContext) { s.Headers["Authorization"] = "Bearer  {value}" },
		"template tab":   func(s *SecretContext) { s.Headers["Authorization"] = "Bearer\t{value}" },
		"add header":     func(s *SecretContext) { s.Headers["X-Extra"] = "{value}" },
		"remove header":  func(s *SecretContext) { delete(s.Headers, "X-Key") },
		"rename header":  func(s *SecretContext) { delete(s.Headers, "X-Key"); s.Headers["X-Other"] = "{value}" },
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			identity := fixtureContext()
			change(&identity)
			plain, err := c.Decrypt(context.Background(), identity, e)
			if !errors.Is(err, ErrAuthentication) || plain != nil {
				t.Fatalf("tampered policy accepted: %v", err)
			}
		})
	}
	identity := fixtureContext()
	identity.Hosts = []string{"*.EXAMPLE.NET", "api.example.com", "API.EXAMPLE.COM"}
	identity.Headers = map[string]string{"x-KEY": "{value}", "authorization": "Bearer {value}"}
	plain, err := c.Decrypt(context.Background(), identity, e)
	if err != nil || string(plain) != "fixture-secret" {
		t.Fatalf("equivalent policy rejected: %v", err)
	}
}

func TestInvalidContext(t *testing.T) {
	c := fixtureCipher(t, fixtureProvider(t, "env:v1", 1))
	e := encryptFixture(t, c, fixtureContext(), []byte("value"))
	cases := map[string]func(*SecretContext){
		"bad org":             func(s *SecretContext) { s.OrganizationID = "bad" },
		"bad secret":          func(s *SecretContext) { s.SecretID = strings.Repeat("g", 36) },
		"bad uuid hex":        func(s *SecretContext) { s.SecretID = "00000000-0000-0000-0000-00000000000g" },
		"bad uuid delimiter":  func(s *SecretContext) { s.SecretID = "00000000_0000-0000-0000-000000000002" },
		"zero version":        func(s *SecretContext) { s.Version = 0 },
		"large version":       func(s *SecretContext) { s.Version = 1 << 31 },
		"no hosts":            func(s *SecretContext) { s.Hosts = nil },
		"empty host":          func(s *SecretContext) { s.Hosts = []string{""} },
		"nil headers":         func(s *SecretContext) { s.Headers = nil },
		"empty headers":       func(s *SecretContext) { s.Headers = map[string]string{} },
		"empty name":          func(s *SecretContext) { s.Headers[""] = "{value}" },
		"invalid name":        func(s *SecretContext) { s.Headers["X:bad"] = "{value}" },
		"non ascii name":      func(s *SecretContext) { s.Headers["X-é"] = "{value}" },
		"duplicate same":      func(s *SecretContext) { s.Headers["authorization"] = "Bearer {value}" },
		"duplicate different": func(s *SecretContext) { s.Headers["authorization"] = "Bot {value}" },
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			identity := fixtureContext()
			change(&identity)
			if _, err := c.Encrypt(context.Background(), identity, []byte("value")); !errors.Is(err, ErrInvalidInput) {
				t.Fatalf("encrypt: %v", err)
			}
			if plain, err := c.Decrypt(context.Background(), identity, e); !errors.Is(err, ErrInvalidInput) || plain != nil {
				t.Fatalf("decrypt: %v", err)
			}
		})
	}
}

func TestAADGoldenAndBoundaries(t *testing.T) {
	identity := fixtureContext()
	identity.Hosts = []string{"B", "a", "A"}
	identity.Headers = map[string]string{"X": " {value}\t"}
	value, dek, err := identity.aad()
	if err != nil {
		t.Fatal(err)
	}
	wantIdentity := "000000000000000000000000000000010000000000000000000000000000000200000003"
	wantPolicy := "000000020000000161000000016200000001000000017800000009207b76616c75657d09"
	if hex.EncodeToString(value) != hex.EncodeToString([]byte("boxlite.secret.value.v1\x00"))+wantIdentity+wantPolicy {
		t.Fatalf("value AAD differs: %x", value)
	}
	if hex.EncodeToString(dek) != hex.EncodeToString([]byte("boxlite.secret.dek.v1\x00"))+wantIdentity {
		t.Fatalf("DEK AAD differs: %x", dek)
	}
	identity.Headers = map[string]string{"ab": "c"}
	a, _, _ := identity.aad()
	identity.Headers = map[string]string{"a": "bc"}
	b, _, _ := identity.aad()
	if bytes.Equal(a, b) {
		t.Fatal("ambiguous name/template framing")
	}
	identity.Hosts = []string{"ab", "c"}
	a, _, _ = identity.aad()
	identity.Hosts = []string{"a", "bc"}
	b, _, _ = identity.aad()
	if bytes.Equal(a, b) {
		t.Fatal("ambiguous host framing")
	}
	identity.Version = 1<<31 - 1
	identity.SecretID = "ABCDEFAB-1234-5678-9012-ABCDEFABCDEF"
	a, _, err = identity.aad()
	if err != nil {
		t.Fatal(err)
	}
	identity.SecretID = strings.ToLower(identity.SecretID)
	b, _, _ = identity.aad()
	if !bytes.Equal(a, b) {
		t.Fatal("UUID casing changed AAD")
	}
}

func TestEnvelopeTampering(t *testing.T) {
	c := fixtureCipher(t, fixtureProvider(t, "env:v1", 1))
	original := encryptFixture(t, c, fixtureContext(), []byte("value"))
	for _, field := range []string{"value", "dek"} {
		size := len(original.Ciphertext)
		if field == "dek" {
			size = len(original.WrappedDEK.Ciphertext)
		}
		for i := 0; i < size; i++ {
			e := original
			e.Ciphertext = bytes.Clone(e.Ciphertext)
			e.WrappedDEK.Ciphertext = bytes.Clone(e.WrappedDEK.Ciphertext)
			if field == "value" {
				e.Ciphertext[i] ^= 1
			} else {
				e.WrappedDEK.Ciphertext[i] ^= 1
			}
			plain, err := c.Decrypt(context.Background(), fixtureContext(), e)
			if err == nil || plain != nil {
				t.Fatalf("accepted modified %s byte %d", field, i)
			}
			if !errors.Is(err, ErrAuthentication) && !errors.Is(err, ErrInvalidInput) && !errors.Is(err, ErrUnknownKey) {
				t.Fatalf("modified %s byte %d returned unexpected error: %v", field, i, err)
			}
		}
		for n := 0; n < size; n++ {
			e := original
			if field == "value" {
				e.Ciphertext = e.Ciphertext[:n]
			} else {
				e.WrappedDEK.Ciphertext = e.WrappedDEK.Ciphertext[:n]
			}
			plain, err := c.Decrypt(context.Background(), fixtureContext(), e)
			if err == nil || plain != nil {
				t.Fatalf("accepted truncated %s length %d", field, n)
			}
			if !errors.Is(err, ErrAuthentication) && !errors.Is(err, ErrInvalidInput) && !errors.Is(err, ErrUnknownKey) {
				t.Fatalf("truncated %s length %d returned unexpected error: %v", field, n, err)
			}
		}
	}
	wrong := fixtureCipher(t, fixtureProvider(t, "env:v1", 2))
	if _, err := wrong.Decrypt(context.Background(), fixtureContext(), original); !errors.Is(err, ErrAuthentication) {
		t.Fatalf("wrong master key: %v", err)
	}
	original.WrappedDEK.KeyID = "env:v2"
	if _, err := c.Decrypt(context.Background(), fixtureContext(), original); !errors.Is(err, ErrUnknownKey) {
		t.Fatalf("unknown key: %v", err)
	}
}

func TestConfigurationAndProviderBoundary(t *testing.T) {
	encoded := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{1}, 32))
	for _, id := range []string{"", "env:", "kms:v1", "env:a/b", "env:é", "env:" + strings.Repeat("a", 125)} {
		if _, err := NewEnvKeyProvider(id, encoded); !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("accepted ID %q", id)
		}
	}
	for _, key := range []string{"", "not-a-key", encoded + "\n", encoded[:43], base64.StdEncoding.EncodeToString(make([]byte, 31)), base64.StdEncoding.EncodeToString(make([]byte, 33)), encoded[:42] + "F="} {
		if _, err := NewEnvKeyProvider("env:v1", key); !errors.Is(err, ErrInvalidInput) {
			t.Fatal("accepted invalid key encoding")
		}
	}
	if _, err := NewCipher(nil); !errors.Is(err, ErrInvalidInput) {
		t.Fatal("accepted nil provider")
	}
	p := fixtureProvider(t, "env:v1", 1)
	for _, n := range []int{0, 31, 33} {
		if _, err := p.Wrap(context.Background(), make([]byte, n), nil); !errors.Is(err, ErrInvalidInput) {
			t.Fatal("accepted wrong DEK size")
		}
	}
	identity := fixtureContext()
	_, aad, _ := identity.aad()
	dek := bytes.Repeat([]byte{2}, 32)
	before := bytes.Clone(dek)
	wrapped, err := p.Wrap(context.Background(), dek, aad)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(dek, before) {
		t.Fatal("provider mutated DEK")
	}
	// Same key bytes under another configured ID must not accept a relabeled blob.
	other := fixtureProvider(t, "env:v2", 1)
	wrapped.KeyID = "env:v2"
	if _, err := other.Unwrap(context.Background(), wrapped, aad); !errors.Is(err, ErrAuthentication) {
		t.Fatalf("key ID not authenticated: %v", err)
	}
}

type testProvider struct {
	KeyProvider
	wrap   func(context.Context, []byte, []byte) (WrappedDEK, error)
	unwrap func(context.Context, WrappedDEK, []byte) ([]byte, error)
}

func (p testProvider) Wrap(ctx context.Context, dek, aad []byte) (WrappedDEK, error) {
	if p.wrap != nil {
		return p.wrap(ctx, dek, aad)
	}
	return p.KeyProvider.Wrap(ctx, dek, aad)
}
func (p testProvider) Unwrap(ctx context.Context, w WrappedDEK, aad []byte) ([]byte, error) {
	if p.unwrap != nil {
		return p.unwrap(ctx, w, aad)
	}
	return p.KeyProvider.Unwrap(ctx, w, aad)
}

func TestFreshDEKsAndRewrap(t *testing.T) {
	p := fixtureProvider(t, "env:v1", 1)
	var keys [][]byte
	c := fixtureCipher(t, testProvider{KeyProvider: p, wrap: func(ctx context.Context, dek, aad []byte) (WrappedDEK, error) {
		keys = append(keys, bytes.Clone(dek))
		return p.Wrap(ctx, dek, aad)
	}})
	e := encryptFixture(t, c, fixtureContext(), []byte("value"))
	_ = encryptFixture(t, c, fixtureContext(), []byte("value"))
	if len(keys) != 2 || len(keys[0]) != 32 || bytes.Equal(keys[0], keys[1]) {
		t.Fatal("DEKs reused")
	}
	_, aad, _ := fixtureContext().aad()
	dek, err := p.Unwrap(context.Background(), e.WrappedDEK, aad)
	if err != nil {
		t.Fatal(err)
	}
	defer clear(dek)
	next := fixtureProvider(t, "env:v2", 2)
	before := bytes.Clone(e.Ciphertext)
	e.WrappedDEK, err = next.Wrap(context.Background(), dek, aad)
	if err != nil {
		t.Fatal(err)
	}
	plain, err := fixtureCipher(t, next).Decrypt(context.Background(), fixtureContext(), e)
	if err != nil || string(plain) != "value" || !bytes.Equal(before, e.Ciphertext) {
		t.Fatalf("rewrap: %v", err)
	}
}

func TestProviderFailuresAndCancellation(t *testing.T) {
	p := fixtureProvider(t, "env:v1", 1)
	e := encryptFixture(t, fixtureCipher(t, p), fixtureContext(), []byte("value"))
	for _, cause := range []error{errors.New("sensitive-provider-detail"), ErrUnknownKey, ErrAuthentication, context.DeadlineExceeded} {
		c := fixtureCipher(t, testProvider{wrap: func(context.Context, []byte, []byte) (WrappedDEK, error) { return WrappedDEK{}, cause }, unwrap: func(context.Context, WrappedDEK, []byte) ([]byte, error) { return []byte("partial"), cause }})
		_, err := c.Encrypt(context.Background(), fixtureContext(), []byte("value"))
		if err != providerError(cause) || strings.Contains(err.Error(), "sensitive") {
			t.Fatal("wrap error classification")
		}
		plain, err := c.Decrypt(context.Background(), fixtureContext(), e)
		if plain != nil || err != providerError(cause) {
			t.Fatal("unwrap error classification")
		}
	}
	for _, n := range []int{0, 31, 33} {
		c := fixtureCipher(t, testProvider{unwrap: func(context.Context, WrappedDEK, []byte) ([]byte, error) { return make([]byte, n), nil }})
		if plain, err := c.Decrypt(context.Background(), fixtureContext(), e); plain != nil || err != ErrProviderUnavailable {
			t.Fatal("accepted malformed provider DEK")
		}
	}
	c := fixtureCipher(t, p)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := c.Encrypt(ctx, fixtureContext(), nil); err != context.Canceled {
		t.Fatal("encrypt ignored cancellation")
	}
	if _, err := c.Decrypt(ctx, fixtureContext(), e); err != context.Canceled {
		t.Fatal("decrypt ignored cancellation")
	}
	if _, err := p.Wrap(ctx, make([]byte, 32), nil); err != context.Canceled {
		t.Fatal("wrap ignored cancellation")
	}
	if _, err := p.Unwrap(ctx, e.WrappedDEK, nil); err != context.Canceled {
		t.Fatal("unwrap ignored cancellation")
	}
	ctx, cancel = context.WithCancel(context.Background())
	defer cancel()
	c = fixtureCipher(t, testProvider{KeyProvider: p, unwrap: func(ctx context.Context, w WrappedDEK, aad []byte) ([]byte, error) {
		key, err := p.Unwrap(ctx, w, aad)
		cancel()
		return key, err
	}})
	if plain, err := c.Decrypt(ctx, fixtureContext(), e); plain != nil || err != context.Canceled {
		t.Fatal("released value after cancellation")
	}
}

func TestConcurrentCipher(t *testing.T) {
	c := fixtureCipher(t, fixtureProvider(t, "env:v1", 1))
	identity := fixtureContext()
	var wg sync.WaitGroup
	for range 16 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range 10 {
				e, err := c.Encrypt(context.Background(), identity, []byte("value"))
				if err != nil {
					t.Error(err)
					return
				}
				v, err := c.Decrypt(context.Background(), identity, e)
				if err != nil || string(v) != "value" {
					t.Errorf("round trip: %v", err)
					return
				}
			}
		}()
	}
	wg.Wait()
}

func TestProviderConstructionAndOutput(t *testing.T) {
	ctx := context.Background()
	for _, p := range []*EnvKeyProvider{nil, {}} {
		if _, err := p.Wrap(ctx, make([]byte, 32), nil); err != ErrInvalidInput {
			t.Fatal("unconfigured provider wrapped a key")
		}
		if _, err := p.Unwrap(ctx, WrappedDEK{}, nil); err != ErrInvalidInput {
			t.Fatal("unconfigured provider unwrapped a key")
		}
	}
	for _, output := range []WrappedDEK{{}, {KeyID: "env:v1"}, {Ciphertext: []byte{1}}} {
		c := fixtureCipher(t, testProvider{wrap: func(context.Context, []byte, []byte) (WrappedDEK, error) { return output, nil }})
		if e, err := c.Encrypt(ctx, fixtureContext(), nil); err != ErrProviderUnavailable || !reflect.DeepEqual(e, Envelope{}) {
			t.Fatal("accepted incomplete provider output")
		}
	}
	p := fixtureProvider(t, "env:v1", 1)
	aad := []byte("context")
	savedAAD := bytes.Clone(aad)
	wrapped, err := p.Wrap(ctx, bytes.Repeat([]byte{2}, 32), aad)
	if err != nil {
		t.Fatal(err)
	}
	saved := bytes.Clone(wrapped.Ciphertext)
	dek, err := p.Unwrap(ctx, wrapped, aad)
	if err != nil {
		t.Fatal(err)
	}
	dek[0] ^= 1
	if !bytes.Equal(saved, wrapped.Ciphertext) || !bytes.Equal(aad, savedAAD) {
		t.Fatal("provider mutated its inputs")
	}
	_, err = p.Unwrap(ctx, wrapped, []byte("other context"))
	if err != ErrAuthentication {
		t.Fatal("provider ignored AAD")
	}
	cancelCtx, cancel := context.WithCancel(ctx)
	c := fixtureCipher(t, testProvider{wrap: func(ctx context.Context, dek, aad []byte) (WrappedDEK, error) {
		w, err := p.Wrap(ctx, dek, aad)
		cancel()
		return w, err
	}})
	if e, err := c.Encrypt(cancelCtx, fixtureContext(), nil); err != context.Canceled || !reflect.DeepEqual(e, Envelope{}) {
		t.Fatal("returned envelope after cancellation")
	}
}

func FuzzContextEncoding(f *testing.F) {
	f.Add("00000000-0000-0000-0000-000000000001", "API.example.com", "Authorization", "Bearer {value}", uint32(1))
	f.Fuzz(func(t *testing.T, id, host, name, template string, version uint32) {
		s := fixtureContext()
		s.OrganizationID = id
		s.Hosts = []string{host}
		s.Headers = map[string]string{name: template}
		s.Version = version
		value, dek, err := s.aad()
		if err == nil && (len(value) < len(dek) || !bytes.HasPrefix(value, []byte("boxlite.secret.value.v1\x00"))) {
			t.Fatal("invalid context encoding")
		}
	})
}

func FuzzDecryptEnvelope(f *testing.F) {
	c := fixtureCipher(f, fixtureProvider(f, "env:v1", 1))
	e := encryptFixture(f, c, fixtureContext(), []byte("value"))
	f.Add(e.Ciphertext, e.WrappedDEK.Ciphertext, "env:v1")
	f.Add([]byte{}, []byte{}, "")
	f.Fuzz(func(t *testing.T, value, dek []byte, id string) {
		v, err := c.Decrypt(context.Background(), fixtureContext(), Envelope{Ciphertext: value, WrappedDEK: WrappedDEK{KeyID: id, Ciphertext: dek}})
		if err != nil && v != nil {
			t.Fatal("partial plaintext")
		}
	})
}
