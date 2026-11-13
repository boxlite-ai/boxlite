package main

import (
	"encoding/json"
	"net/http/httptest"
	"testing"
)

func TestSecretHeadersTemplates(t *testing.T) {
	var secret SecretConfig
	if err := json.Unmarshal([]byte(`{"value":"token{value}","headers":{"Authorization":"Bot {value}","X-Key":"{value}","X-Absent":"{value}"}}`), &secret); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest("GET", "https://api.example.com", nil)
	req.Header.Set("Authorization", "")
	req.Header.Set("X-Key", "arbitrary")
	req.Header.Set("X-Unrelated", "keep")
	injectSecretHeaders(req, req.Header.Clone(), []SecretConfig{secret})
	if got := req.Header.Get("Authorization"); got != "Bot token{value}" {
		t.Errorf("Authorization = %q, want nonrecursive Bot template", got)
	}
	if got := req.Header.Get("X-Key"); got != "token{value}" {
		t.Errorf("X-Key = %q, want raw secret", got)
	}
	if _, present := req.Header["X-Absent"]; present {
		t.Error("absent header was injected")
	}
	if req.Header.Get("X-Unrelated") != "keep" {
		t.Error("unrelated header changed")
	}
}
