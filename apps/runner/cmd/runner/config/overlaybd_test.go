package config

import (
	"os"
	"strings"
	"testing"
)

func TestOverlayBDConfig(t *testing.T) {
	t.Setenv("BOXLITE_API_URL", "http://127.0.0.1:3000")
	t.Setenv("BOXLITE_RUNNER_TOKEN", "YOUR_API_TOKEN")
	t.Setenv("RUNNER_DOMAIN", "127.0.0.1")
	for _, value := range []string{"", "false", "true", "not-a-bool"} {
		t.Run("value="+value, func(t *testing.T) {
			previous := config
			config = nil
			t.Cleanup(func() { config = previous })
			t.Setenv("BOXLITE_OVERLAYBD_ENABLED", value)
			if value == "" {
				if err := os.Unsetenv("BOXLITE_OVERLAYBD_ENABLED"); err != nil {
					t.Fatal(err)
				}
			}
			cfg, err := GetConfig()
			if value == "not-a-bool" {
				if err == nil || !strings.Contains(err.Error(), "BOXLITE_OVERLAYBD_ENABLED") {
					t.Fatal("expected invalid BOXLITE_OVERLAYBD_ENABLED to fail configuration")
				}
				return
			}
			if err != nil {
				t.Fatal("valid runner configuration was rejected")
			}
			if cfg.OverlayBDEnabled != (value == "true") {
				t.Fatalf("OverlayBDEnabled = %v for %q", cfg.OverlayBDEnabled, value)
			}
		})
	}
}
