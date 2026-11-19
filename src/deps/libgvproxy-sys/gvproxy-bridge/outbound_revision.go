package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
)

const outboundRevisionHeader = "X-Boxlite-Outbound-Revision"
const outboundStatusPath = "/network/outbound/status"
const outboundSnapshotPath = "/network/outbound/snapshot"

func newOutboundRevision() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", fmt.Errorf("allocate outbound revision: %w", err)
	}
	return hex.EncodeToString(value[:]), nil
}

func validOutboundRevision(value string) bool {
	if len(value) == 0 || len(value) > 128 {
		return false
	}
	for _, c := range value {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
			return false
		}
	}
	return true
}

// If-Match uses strong comparison. Parse the complete list before accepting a
// match, so a valid tag followed by malformed input cannot authorize a write.
func matchesOutboundRevision(condition, revision string) bool {
	condition = strings.Trim(condition, " \t")
	if condition == "*" {
		return true
	}
	matched := false
	for condition != "" {
		if condition[0] == ',' {
			condition = strings.TrimLeft(condition[1:], " \t")
			continue
		}
		weak := strings.HasPrefix(condition, "W/")
		if weak {
			condition = condition[2:]
		}
		if len(condition) < 2 || condition[0] != '"' {
			return false
		}
		end := strings.IndexByte(condition[1:], '"') + 1
		if end == 0 {
			return false
		}
		value := condition[1:end]
		for _, c := range []byte(value) {
			if c < 0x21 || c == 0x7f {
				return false
			}
		}
		matched = matched || !weak && value == revision
		condition = strings.TrimLeft(condition[end+1:], " \t")
		if condition == "" {
			return matched
		}
		if condition[0] != ',' {
			return false
		}
		condition = strings.TrimLeft(condition[1:], " \t")
	}
	return matched
}

func revisionForOutboundUpdate(r *http.Request, current string) (string, int, error) {
	conditions := r.Header.Values("If-Match")
	condition := strings.Trim(strings.Join(conditions, ","), " \t")
	values := r.Header.Values(outboundRevisionHeader)
	if len(values) > 1 {
		return "", http.StatusBadRequest, fmt.Errorf("expected one candidate revision")
	}
	candidate := ""
	if len(values) == 1 {
		candidate = values[0]
		if !validOutboundRevision(candidate) || candidate == "initial" {
			return "", http.StatusBadRequest, fmt.Errorf("invalid candidate revision")
		}
		if len(condition) < 2 || condition[0] != '"' || condition[len(condition)-1] != '"' || !validOutboundRevision(condition[1:len(condition)-1]) {
			return "", http.StatusBadRequest, fmt.Errorf("candidate revision requires one strong expected revision")
		}
	}
	if len(conditions) > 0 && !matchesOutboundRevision(condition, current) {
		return "", http.StatusPreconditionFailed, fmt.Errorf("outbound revision precondition failed")
	}
	if candidate == "" {
		value, err := newOutboundRevision()
		if err != nil {
			return "", http.StatusInternalServerError, err
		}
		return value, http.StatusOK, nil
	}
	if candidate == current {
		return "", http.StatusBadRequest, fmt.Errorf("candidate revision must be fresh")
	}
	return candidate, http.StatusOK, nil
}

func (p *outboundPolicyController) serveStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		http.Error(w, "GET required", http.StatusMethodNotAllowed)
		return
	}
	snapshot := p.active.Load()
	if snapshot.policy.complete != nil {
		http.Error(w, "outbound policy requires complete status", http.StatusNotImplemented)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(struct {
		Policy       outboundPolicy `json:"policy"`
		Revision     string         `json:"revision"`
		State        string         `json:"application_state"`
		Capabilities []string       `json:"capabilities"`
	}{snapshot.policy, snapshot.revision, snapshot.state, []string{"revision-v1"}})
}

func outboundETag(revision string) string { return strconv.Quote(revision) }
