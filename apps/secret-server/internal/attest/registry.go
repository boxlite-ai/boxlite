package attest

import (
	"encoding/json"
	"fmt"
)

// Registry maps each attestor mode to its known machines, for example
// {"gcp_iit": {"<instance_id>": "<runner_id>"}}. The Secret Server loads it
// from its own configuration; the API has no write path to it.
type Registry map[string]map[string]RunnerID

// ParseRegistry requires JSON objects for the registry and each mode.
// It rejects unknown modes and empty IDs. An empty string supports dev-only runs.
func ParseRegistry(raw string) (Registry, error) {
	if raw == "" {
		return Registry{}, nil
	}
	var reg Registry
	if err := json.Unmarshal([]byte(raw), &reg); err != nil || reg == nil {
		// The decoder's message can quote registry content; keep only the kind.
		return nil, fmt.Errorf("attest: registry is not valid JSON of the form {mode: {machine: runner}}")
	}
	for mode, machines := range reg {
		if _, ok := knownAttestors[mode]; !ok {
			return nil, fmt.Errorf("attest: registry mode %q is not a known attestor", mode)
		}
		if machines == nil {
			return nil, fmt.Errorf("attest: registry mode %q must be a JSON object", mode)
		}
		for machine, runner := range machines {
			if machine == "" || runner == "" {
				return nil, fmt.Errorf("attest: registry mode %q has an empty machine or runner ID", mode)
			}
		}
	}
	return reg, nil
}

// registeredElsewhere reports whether runner is registered under a mode other
// than mode, which binds each runner to the one attestor it was registered for.
func (r Registry) registeredElsewhere(mode string, runner RunnerID) bool {
	for other, machines := range r {
		if other == mode {
			continue
		}
		for _, registered := range machines {
			if registered == runner {
				return true
			}
		}
	}
	return false
}
