package server

import (
	"strings"
	"testing"
)

func TestLoadConfig(t *testing.T) {
	for name, value := range map[string]string{"SECRET_SERVER_ROLE": "write", "ENVIRONMENT": "local", "DATABASE_URL": "postgres://local/db", "SECRET_MASTER_KEY_ID": "env:test", "SECRET_MASTER_KEY_BASE64": "key", "SECRET_SERVER_AUTH_MODE": "dev", "SECRET_SERVER_DEV_TOKEN": "token", "SECRET_SERVER_AUDIENCE": "", "SECRET_SERVER_ALLOWED_CALLERS": "", "PORT": "", "SHUTDOWN_TIMEOUT_SEC": ""} {
		t.Setenv(name, value)
	}
	if _, err := LoadConfig(); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ name, value string }{{"SECRET_SERVER_ROLE", "other"}, {"ENVIRONMENT", "production"}, {"SECRET_SERVER_AUTH_MODE", "other"}, {"SECRET_SERVER_DEV_TOKEN", ""}, {"SHUTDOWN_TIMEOUT_SEC", "0"}} {
		t.Run(tc.name+tc.value, func(t *testing.T) {
			t.Setenv(tc.name, tc.value)
			if _, err := LoadConfig(); err == nil {
				t.Fatal("expected invalid configuration")
			}
		})
	}
}

func TestConfigRejectsDevInStagingWithoutLeakingValues(t *testing.T) {
	for name, value := range map[string]string{"SECRET_SERVER_ROLE": "write", "ENVIRONMENT": "staging", "DATABASE_URL": "postgres://secret-marker/db", "SECRET_MASTER_KEY_ID": "env:test", "SECRET_MASTER_KEY_BASE64": "secret-marker", "SECRET_SERVER_AUTH_MODE": "dev", "SECRET_SERVER_DEV_TOKEN": "secret-marker", "SECRET_SERVER_AUDIENCE": "", "SECRET_SERVER_ALLOWED_CALLERS": "", "PORT": "", "SHUTDOWN_TIMEOUT_SEC": ""} {
		t.Setenv(name, value)
	}
	_, err := LoadConfig()
	if err == nil || !strings.Contains(err.Error(), "SECRET_SERVER_AUTH_MODE") || strings.Contains(err.Error(), "secret-marker") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestConfigReportsVariableWithoutValue(t *testing.T) {
	baseline := map[string]string{"SECRET_SERVER_ROLE": "write", "ENVIRONMENT": "local", "DATABASE_URL": "postgres://host/db", "SECRET_MASTER_KEY_ID": "env:test", "SECRET_MASTER_KEY_BASE64": "key", "SECRET_SERVER_AUTH_MODE": "dev", "SECRET_SERVER_DEV_TOKEN": "token", "SECRET_SERVER_AUDIENCE": "", "SECRET_SERVER_ALLOWED_CALLERS": "", "PORT": "", "SHUTDOWN_TIMEOUT_SEC": ""}
	for name, value := range baseline {
		t.Setenv(name, value)
	}
	for _, tc := range []struct{ name, value string }{{"SECRET_SERVER_ROLE", "sensitive-marker"}, {"ENVIRONMENT", "sensitive-marker"}, {"DATABASE_URL", ""}, {"SECRET_MASTER_KEY_ID", ""}, {"SECRET_MASTER_KEY_BASE64", ""}, {"SECRET_SERVER_AUTH_MODE", "sensitive-marker"}, {"SECRET_SERVER_DEV_TOKEN", ""}, {"PORT", "sensitive-marker"}, {"SHUTDOWN_TIMEOUT_SEC", "sensitive-marker"}} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv(tc.name, tc.value)
			_, err := LoadConfig()
			if err == nil || !strings.Contains(err.Error(), tc.name) || strings.Contains(err.Error(), "sensitive-marker") {
				t.Fatalf("error %v", err)
			}
		})
	}
	t.Run("google audience", func(t *testing.T) {
		t.Setenv("SECRET_SERVER_AUTH_MODE", "google")
		t.Setenv("SECRET_SERVER_AUDIENCE", "sensitive-marker")
		_, err := LoadConfig()
		if err == nil || !strings.Contains(err.Error(), "SECRET_SERVER_AUDIENCE") || strings.Contains(err.Error(), "sensitive-marker") {
			t.Fatalf("error %v", err)
		}
	})
	t.Run("google callers", func(t *testing.T) {
		t.Setenv("SECRET_SERVER_AUTH_MODE", "google")
		t.Setenv("SECRET_SERVER_AUDIENCE", "https://example.invalid")
		_, err := LoadConfig()
		if err == nil || !strings.Contains(err.Error(), "SECRET_SERVER_ALLOWED_CALLERS") {
			t.Fatalf("error %v", err)
		}
	})
}
