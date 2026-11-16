package main

// SecretConfig holds a secret's configuration for header injection.
type SecretConfig struct {
	Name        string            `json:"name"`
	Hosts       []string          `json:"hosts"`
	Placeholder string            `json:"placeholder"`
	Value       string            `json:"value"`
	Headers     map[string]string `json:"headers"`
}

func (s SecretConfig) String() string {
	return "SecretConfig{Name:" + s.Name + ", Placeholder:" + s.Placeholder + ", Value:[REDACTED]}"
}
