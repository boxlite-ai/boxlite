package boxlite

import (
	"encoding/json"
	"testing"
)

func TestWireFormat_Defaults(t *testing.T) {
	cfg := &boxConfig{}
	w := buildOptionsJSON("alpine:latest", cfg)
	data, err := json.Marshal(w)
	if err != nil {
		t.Fatal(err)
	}
	s := string(data)

	// env must be [] not null
	if !contains(s, `"env":[]`) {
		t.Errorf("env should be [], got: %s", s)
	}
	// volumes must be [] not null
	if !contains(s, `"volumes":[]`) {
		t.Errorf("volumes should be [], got: %s", s)
	}
	// ports must be [] not null
	if !contains(s, `"ports":[]`) {
		t.Errorf("ports should be [], got: %s", s)
	}
	// entrypoint must be [] not null
	if !contains(s, `"entrypoint":[]`) {
		t.Errorf("entrypoint should be [], got: %s", s)
	}
	// cmd must be [] not null
	if !contains(s, `"cmd":[]`) {
		t.Errorf("cmd should be [], got: %s", s)
	}
	// network must be Enabled not Isolated
	if contains(s, `"Isolated"`) {
		t.Errorf("network should not be Isolated, got: %s", s)
	}
	if !contains(s, `"Enabled"`) {
		t.Errorf("network should be Enabled, got: %s", s)
	}
	if !contains(s, `"allow_net":[]`) {
		t.Errorf("allow_net should be [], got: %s", s)
	}
	t.Logf("JSON: %s", s)
}

func TestWireFormat_WithPort(t *testing.T) {
	cfg := &boxConfig{}
	WithPort(2280, 0)(cfg)
	w := buildOptionsJSON("alpine:latest", cfg)
	data, _ := json.Marshal(w)
	s := string(data)

	if !contains(s, `"protocol":"Tcp"`) {
		t.Errorf("protocol should be Tcp, got: %s", s)
	}
	if !contains(s, `"guest_port":2280`) {
		t.Errorf("guest_port should be 2280, got: %s", s)
	}
	t.Logf("JSON: %s", s)
}

func TestWireFormat_NetworkDisabled(t *testing.T) {
	cfg := &boxConfig{}
	WithNetwork(NetworkDisabled())(cfg)
	w := buildOptionsJSON("alpine:latest", cfg)
	data, _ := json.Marshal(w)
	s := string(data)

	if !contains(s, `"Disabled"`) {
		t.Errorf("network should be Disabled, got: %s", s)
	}
	t.Logf("JSON: %s", s)
}

func TestWireFormat_NetworkAllowList(t *testing.T) {
	cfg := &boxConfig{}
	WithNetwork(NetworkEnabledWithAllowList("example.com", "10.0.0.0/8"))(cfg)
	w := buildOptionsJSON("alpine:latest", cfg)
	data, _ := json.Marshal(w)
	s := string(data)

	if !contains(s, `"allow_net":["example.com","10.0.0.0/8"]`) {
		t.Errorf("allow_net should have entries, got: %s", s)
	}
	t.Logf("JSON: %s", s)
}

func TestWireFormat_FullConfig(t *testing.T) {
	cfg := &boxConfig{}
	WithName("test-sandbox")(cfg)
	WithCPUs(2)(cfg)
	WithMemory(512)(cfg)
	WithDiskSize(10)(cfg)
	WithUser("ubuntu")(cfg)
	WithEnv("FOO", "bar")(cfg)
	WithPort(2280, 0)(cfg)
	WithNetwork(NetworkEnabled())(cfg)
	WithAutoRemove(false)(cfg)
	WithDetach(true)(cfg)

	w := buildOptionsJSON("ubuntu:22.04", cfg)
	data, err := json.Marshal(w)
	if err != nil {
		t.Fatal(err)
	}
	s := string(data)

	// Verify no null values
	if contains(s, ":null") {
		t.Errorf("should not contain null values, got: %s", s)
	}
	// Verify no "Isolated"
	if contains(s, "Isolated") {
		t.Errorf("should not contain Isolated, got: %s", s)
	}
	t.Logf("JSON: %s", s)
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && searchString(s, substr)
}

func searchString(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}
