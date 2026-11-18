package server

import (
	"context"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"net/http"
	"strings"

	"google.golang.org/api/idtoken"
)

type validateToken func(context.Context, string, string) (*idtoken.Payload, error)

func problem(w http.ResponseWriter, status int, code string) {
	w.Header().Set("Content-Type", "application/problem+json")
	w.WriteHeader(status)
	_, _ = fmt.Fprintf(w, `{"type":"about:blank","title":%q,"status":%d,"code":%q}`, http.StatusText(status), status, code)
}

func writeAuth(c Config, validate validateToken, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Values("Authorization")
		if len(auth) != 1 || !strings.HasPrefix(auth[0], "Bearer ") {
			problem(w, 401, "unauthorized")
			return
		}
		token := strings.TrimPrefix(auth[0], "Bearer ")
		if c.AuthMode == "dev" {
			if subtle.ConstantTimeCompare([]byte(token), []byte(c.DevToken)) != 1 {
				problem(w, 401, "unauthorized")
				return
			}
		} else {
			// idtoken v0.247.0 slices ES256 signatures at 32 bytes without a length check.
			segments := strings.Split(token, ".")
			if len(segments) == 3 {
				if signature, err := base64.RawURLEncoding.DecodeString(segments[2]); err == nil && len(signature) < 32 {
					problem(w, http.StatusUnauthorized, "unauthorized")
					return
				}
			}
			p, err := validate(r.Context(), token, c.Audience)
			if err != nil || p == nil || (p.Issuer != "accounts.google.com" && p.Issuer != "https://accounts.google.com") {
				problem(w, 401, "unauthorized")
				return
			}
			email, ok := p.Claims["email"].(string)
			verified, valid := p.Claims["email_verified"].(bool)
			allowed := false
			for _, caller := range c.AllowedCallers {
				if caller == email {
					allowed = true
					break
				}
			}
			if !ok || email == "" || !valid || !verified || !allowed {
				problem(w, 401, "unauthorized")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}
