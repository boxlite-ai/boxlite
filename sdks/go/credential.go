package boxlite

import (
	"os"
	"time"
)

// AccessToken is a bearer token plus its expiry. A nil ExpiresAt means
// the token never expires (e.g. long-lived API keys) — the SDK fetches
// it once and never re-requests. Mirrors the core `AccessToken`.
type AccessToken struct {
	Token     string
	ExpiresAt *time.Time
}

// Credential abstracts a bearer credential for the REST API, mirroring
// the core `Credential` trait and the Python/Node `Credential` types.
// GetToken returns the current token and its expiry.
type Credential interface {
	GetToken() AccessToken
}

// ApiKeyCredential is a long-lived opaque API key — the only concrete
// Credential shipped today.
type ApiKeyCredential struct {
	key string
}

// NewApiKeyCredential creates an API-key credential. The key is sent as
// `Authorization: Bearer <key>`.
func NewApiKeyCredential(key string) *ApiKeyCredential {
	return &ApiKeyCredential{key: key}
}

// ApiKeyCredentialFromEnv reads the API key from BOXLITE_API_KEY. ok is
// false if the variable is unset or empty.
func ApiKeyCredentialFromEnv() (cred *ApiKeyCredential, ok bool) {
	key := os.Getenv("BOXLITE_API_KEY")
	if key == "" {
		return nil, false
	}
	return &ApiKeyCredential{key: key}, true
}

// GetToken returns the API key as a never-expiring bearer token.
func (c *ApiKeyCredential) GetToken() AccessToken {
	return AccessToken{Token: c.key, ExpiresAt: nil}
}
