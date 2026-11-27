package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/boxlite-ai/secret-server/internal/database"
)

type transferRequest struct {
	OrgID     string           `json:"org_id"`
	CreatedBy string           `json:"created_by"`
	Secrets   []transferSecret `json:"secrets"`
}

type transferSecret struct {
	Name        string            `json:"name"`
	Value       string            `json:"value"`
	Hosts       []string          `json:"hosts"`
	Headers     map[string]string `json:"headers"`
	Placeholder string            `json:"placeholder"`
	Normalized  string            `json:"-"`
}

type requestError struct {
	status      int
	code, field string
}

func (e *requestError) Error() string { return e.code }

func invalid(code, field string) *requestError {
	return &requestError{status: http.StatusUnprocessableEntity, code: code, field: field}
}

type jsonShape int

const (
	stringJSON jsonShape = iota
	transferJSON
	secretsJSON
	secretJSON
	hostsJSON
	headersJSON
)

// inspectJSON checks duplicates everywhere and exact field names on request objects.
func inspectJSON(dec *json.Decoder, shape jsonShape) error {
	token, err := dec.Token()
	if err != nil {
		return err
	}
	if shape == stringJSON {
		if _, ok := token.(string); !ok {
			return fmt.Errorf("expected a string")
		}
		return nil
	}
	switch shape {
	case transferJSON, secretJSON, headersJSON:
		if token != json.Delim('{') {
			return fmt.Errorf("expected an object")
		}
		seen := map[string]bool{}
		for dec.More() {
			key, err := dec.Token()
			if err != nil {
				return err
			}
			name, ok := key.(string)
			if !ok || seen[name] {
				return fmt.Errorf("duplicate or invalid key")
			}
			child := stringJSON
			switch shape {
			case transferJSON:
				switch name {
				case "org_id", "created_by":
				case "secrets":
					child = secretsJSON
				default:
					return fmt.Errorf("unknown transfer field")
				}
			case secretJSON:
				switch name {
				case "name", "value", "placeholder":
				case "hosts":
					child = hostsJSON
				case "headers":
					child = headersJSON
				default:
					return fmt.Errorf("unknown secret field")
				}
			}
			seen[name] = true
			if err := inspectJSON(dec, child); err != nil {
				return err
			}
		}
		end, err := dec.Token()
		if err != nil || end != json.Delim('}') {
			return fmt.Errorf("invalid object")
		}
	case secretsJSON, hostsJSON:
		if token != json.Delim('[') {
			return fmt.Errorf("expected an array")
		}
		child := stringJSON
		if shape == secretsJSON {
			child = secretJSON
		}
		for dec.More() {
			if err := inspectJSON(dec, child); err != nil {
				return err
			}
		}
		end, err := dec.Token()
		if err != nil || end != json.Delim(']') {
			return fmt.Errorf("invalid array")
		}
	default:
		return fmt.Errorf("invalid delimiter")
	}
	return nil
}

// Check Unicode before encoding/json can replace invalid bytes or isolated surrogates.
func validJSONUnicode(body []byte) bool {
	if !utf8.Valid(body) {
		return false
	}
	for i := 0; i < len(body); i++ {
		if body[i] != '\\' {
			continue
		}
		i++ // Skip escaped backslashes as well as the other single-character escapes.
		if i >= len(body) || body[i] != 'u' {
			continue
		}
		if i+4 >= len(body) {
			return false
		}
		code, err := strconv.ParseUint(string(body[i+1:i+5]), 16, 16)
		if err != nil || code >= 0xDC00 && code <= 0xDFFF {
			return false
		}
		i += 4
		if code >= 0xD800 && code <= 0xDBFF {
			if i+6 >= len(body) || body[i+1] != '\\' || body[i+2] != 'u' {
				return false
			}
			low, err := strconv.ParseUint(string(body[i+3:i+7]), 16, 16)
			if err != nil || low < 0xDC00 || low > 0xDFFF {
				return false
			}
			i += 6
		}
	}
	return true
}

func decodeTransfer(body []byte) (transferRequest, *requestError) {
	bad := &requestError{status: http.StatusBadRequest, code: "malformed_json"}
	if !validJSONUnicode(body) {
		return transferRequest{}, bad
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	if err := inspectJSON(dec, transferJSON); err != nil {
		return transferRequest{}, bad
	}
	if _, err := dec.Token(); err != io.EOF {
		return transferRequest{}, bad
	}
	dec = json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	var req transferRequest
	if err := dec.Decode(&req); err != nil || len(req.Secrets) == 0 {
		return transferRequest{}, bad
	}
	return req, nil
}

func isUUID(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i, c := range s {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if c != '-' {
				return false
			}
			continue
		}
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F') {
			return false
		}
	}
	return true
}

func hasControls(s string, allowTab bool) bool {
	for i := 0; i < len(s); i++ {
		if s[i] == 0x7f || s[i] < 0x20 && !(allowTab && s[i] == '\t') {
			return true
		}
	}
	return false
}

func headerToken(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.ContainsRune("!#$%&'*+-.^_`|~", rune(c))) {
			return false
		}
	}
	return true
}

func validateTransfer(ctx context.Context, boxID string, req *transferRequest) *requestError {
	if len(boxID) != 12 {
		return invalid("box_id_invalid", "box_id")
	}
	for _, c := range boxID {
		if !(c >= '0' && c <= '9' || c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z') {
			return invalid("box_id_invalid", "box_id")
		}
	}
	if !isUUID(req.OrgID) {
		return invalid("org_id_invalid", "org_id")
	}
	if len(req.CreatedBy) == 0 || len(req.CreatedBy) > 255 || hasControls(req.CreatedBy, false) {
		return invalid("created_by_invalid", "created_by")
	}
	if len(req.Secrets) > 64 {
		return invalid("quota_exceeded", "secrets")
	}
	names := map[string]bool{}
	// One bit per secret tracks shared hosts and headers without expanding their pairs.
	hostOwners, headerOwners := map[string]uint64{}, map[string]uint64{}
	for i := range req.Secrets {
		if err := ctx.Err(); err != nil {
			return transferError(ctx, err)
		}
		s := &req.Secrets[i]
		field := func(name string) string { return fmt.Sprintf("secrets[%d].%s", i, name) }
		normalized, err := database.NormalizeName(s.Name)
		if err != nil {
			return invalid("name_invalid", field("name"))
		}
		if names[normalized] {
			return invalid("name_conflict", field("name"))
		}
		names[normalized], s.Normalized = true, normalized
		if s.Value == "" {
			return invalid("value_required", field("value"))
		}
		if len(s.Value) > 65536 {
			return invalid("value_too_large", field("value"))
		}
		if hasControls(s.Value, true) {
			return invalid("value_invalid", field("value"))
		}
		if len(s.Hosts) == 0 {
			return invalid("hosts_invalid", field("hosts"))
		}
		secretBit := uint64(1) << i
		var sharedHostOwners uint64
		for _, host := range s.Hosts {
			if host == "" || strings.ContainsRune(host, '\x00') {
				return invalid("hosts_invalid", field("hosts"))
			}
			lower := strings.ToLower(host)
			sharedHostOwners |= hostOwners[lower] &^ secretBit
			hostOwners[lower] |= secretBit
		}
		if s.Placeholder == "" || strings.ContainsRune(s.Placeholder, '\x00') {
			return invalid("placeholder_invalid", field("placeholder"))
		}
		if len(s.Headers) == 0 {
			return invalid("headers_invalid", field("headers"))
		}
		for name, template := range s.Headers {
			lower := strings.ToLower(name)
			switch lower {
			case "host", "content-length", "connection", "proxy-connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade":
				return invalid("headers_invalid", field("headers"))
			}
			if !headerToken(name) || headerOwners[lower]&(secretBit|sharedHostOwners) != 0 || hasControls(template, true) || strings.Count(template, "{value}") != 1 || strings.ContainsAny(strings.Replace(template, "{value}", "", 1), "{}") {
				return invalid("headers_invalid", field("headers"))
			}
			headerOwners[lower] |= secretBit
		}
	}
	return nil
}
