package guardinventory

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
)

func normalizeTopologyJSON(raw []byte, routes bool) ([]byte, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var records any
	if err := decoder.Decode(&records); err != nil {
		return nil, err
	}
	if decoder.Decode(new(any)) != io.EOF {
		return nil, fmt.Errorf("expected one topology response")
	}
	if routes {
		entries, ok := records.([]any)
		if !ok {
			return nil, fmt.Errorf("expected an applied route list")
		}
		for _, record := range entries {
			entry, ok := record.(map[string]any)
			if !ok {
				return nil, fmt.Errorf("invalid applied route")
			}
			// Track the route until the kernel removes it. The remaining
			// lifetime of each periodically renewed RA route is transient.
			delete(entry, "expires")
		}
	} else {
		discardNftCounters(records)
	}
	return json.Marshal(records)
}

func discardNftCounters(value any) {
	switch value := value.(type) {
	case []any:
		for _, child := range value {
			discardNftCounters(child)
		}
	case map[string]any:
		for name, child := range value {
			if counter, ok := child.(map[string]any); name == "counter" && ok {
				delete(counter, "packets")
				delete(counter, "bytes")
			}
			discardNftCounters(child)
		}
	}
}
