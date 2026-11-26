package server

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestInspectJSONRejectsNestedScalarEarly(t *testing.T) {
	const prefix = `{"created_by":[`
	input := prefix + strings.Repeat("[", 128) + `null` + strings.Repeat("]", 129) + `}`
	dec := json.NewDecoder(strings.NewReader(input))
	if err := inspectJSON(dec, transferJSON); err == nil || dec.InputOffset() != int64(len(prefix)) {
		t.Fatalf("invalid container must be rejected at its opening delimiter, got offset=%d, err=%v", dec.InputOffset(), err)
	}
}

func TestDecodeTransfer(t *testing.T) {
	for _, input := range []string{
		``,
		`[]`,
		`{0:"invalid"}`,
		`{"org_id":"o"`,
		`{"secrets":{}}`,
		`{"secrets":[{"hosts":["example.com",`,
		`{"secrets":[{"value":"\u`,
		`{"secrets":[{"value":"\uXYZ0"}]}`,
		`{"secrets":[{"value":"\uD800\u0041"}]}`,
		`{"secrets":[]}`,
		`{"secrets":[null]}`,
		`{"org_id":"one","org_id":"two","secrets":[{}]}`,
		`{"secrets":[{"headers":{"x":"a","x":"b"}}]}`,
		`{"secrets":[{}]} {}`,
		`{"secrets":[{}],"unknown":1}`,
	} {
		if _, err := decodeTransfer([]byte(input)); err == nil || err.code != "malformed_json" {
			t.Errorf("decode %q: %v", input, err)
		}
	}
}

func TestValidateTransferBoundsDestinationAllocations(t *testing.T) {
	s := transferSecret{Name: "KEY", Value: "v", Placeholder: "p", Headers: make(map[string]string)}
	for i := 0; i < 512; i++ {
		s.Hosts = append(s.Hosts, fmt.Sprintf("host-%d.example.com", i))
		s.Headers[fmt.Sprintf("X-Key-%d", i)] = "{value}"
	}
	req := transferRequest{OrgID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", CreatedBy: "user", Secrets: []transferSecret{s}}
	allocations := testing.AllocsPerRun(1, func() {
		if err := validateTransfer(t.Context(), "Box123456789", &req); err != nil {
			t.Fatalf("valid routing policy rejected: %v", err)
		}
	})
	if allocations > 10_000 {
		t.Fatalf("validation allocated %.0f objects for 512 hosts and 512 headers, want at most 10000", allocations)
	}
}

func TestValidateTransfer(t *testing.T) {
	valid := func() transferRequest {
		return transferRequest{OrgID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", CreatedBy: "user", Secrets: []transferSecret{{Name: "api-key", Value: "secret", Hosts: []string{"example.com"}, Headers: map[string]string{"Authorization": "Bearer {value}"}, Placeholder: "placeholder"}}}
	}
	for _, tc := range []struct {
		name, box, code string
		mutate          func(*transferRequest)
	}{
		{"valid", "Box123456789", "", func(*transferRequest) {}},
		{"box", "bad", "box_id_invalid", func(*transferRequest) {}},
		{"box characters", "Box12345678_", "box_id_invalid", func(*transferRequest) {}},
		{"org", "Box123456789", "org_id_invalid", func(r *transferRequest) { r.OrgID = "bad" }},
		{"org separator", "Box123456789", "org_id_invalid", func(r *transferRequest) { r.OrgID = strings.Replace(r.OrgID, "-", "0", 1) }},
		{"org digit", "Box123456789", "org_id_invalid", func(r *transferRequest) { r.OrgID = "x" + r.OrgID[1:] }},
		{"creator", "Box123456789", "created_by_invalid", func(r *transferRequest) { r.CreatedBy = "a\nb" }},
		{"empty name", "Box123456789", "name_invalid", func(r *transferRequest) { r.Secrets[0].Name = "" }},
		{"empty value", "Box123456789", "value_required", func(r *transferRequest) { r.Secrets[0].Value = "" }},
		{"large value", "Box123456789", "value_too_large", func(r *transferRequest) { r.Secrets[0].Value = strings.Repeat("a", 65537) }},
		{"control value", "Box123456789", "value_invalid", func(r *transferRequest) { r.Secrets[0].Value = "a\x7fb" }},
		{"hosts", "Box123456789", "hosts_invalid", func(r *transferRequest) { r.Secrets[0].Hosts = []string{""} }},
		{"empty host list", "Box123456789", "hosts_invalid", func(r *transferRequest) { r.Secrets[0].Hosts = []string{} }},
		{"placeholder", "Box123456789", "placeholder_invalid", func(r *transferRequest) { r.Secrets[0].Placeholder = "" }},
		{"header name", "Box123456789", "headers_invalid", func(r *transferRequest) { r.Secrets[0].Headers = map[string]string{"Host": "{value}"} }},
		{"empty headers", "Box123456789", "headers_invalid", func(r *transferRequest) { r.Secrets[0].Headers = map[string]string{} }},
		{"empty header name", "Box123456789", "headers_invalid", func(r *transferRequest) { r.Secrets[0].Headers = map[string]string{"": "{value}"} }},
		{"invalid header token", "Box123456789", "headers_invalid", func(r *transferRequest) { r.Secrets[0].Headers = map[string]string{"X Key": "{value}"} }},
		{"header template", "Box123456789", "headers_invalid", func(r *transferRequest) { r.Secrets[0].Headers["Authorization"] = "{value}{value}" }},
		{"quota", "Box123456789", "quota_exceeded", func(r *transferRequest) { r.Secrets = make([]transferSecret, 65) }},
		{"normalized names", "Box123456789", "name_conflict", func(r *transferRequest) { r.Secrets = append(r.Secrets, r.Secrets[0]); r.Secrets[1].Name = "API_KEY" }},
		{"same destination", "Box123456789", "headers_invalid", func(r *transferRequest) { r.Secrets = append(r.Secrets, r.Secrets[0]); r.Secrets[1].Name = "OTHER" }},
		{"separate destinations", "Box123456789", "", func(r *transferRequest) {
			other, third := r.Secrets[0], r.Secrets[0]
			other.Name, other.Hosts = "OTHER", []string{"other.example.com"}
			other.Headers = map[string]string{"X-Api-Key": "{value}"}
			third.Name, third.Headers = "THIRD", other.Headers
			r.Secrets = append(r.Secrets, other, third)
		}},
		{"repeated host", "Box123456789", "", func(r *transferRequest) { r.Secrets[0].Hosts = []string{"example.com", "EXAMPLE.COM"} }},
		{"boundary value", "Box123456789", "", func(r *transferRequest) { r.Secrets[0].Value = strings.Repeat("a", 65536) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := valid()
			tc.mutate(&r)
			got := validateTransfer(t.Context(), tc.box, &r)
			if tc.code == "" && got != nil || tc.code != "" && (got == nil || got.code != tc.code) {
				t.Fatalf("got %v; want %q", got, tc.code)
			}
			if tc.name == "valid" && r.Secrets[0].Normalized != "API_KEY" {
				t.Fatalf("normalized: %q", r.Secrets[0].Normalized)
			}
		})
	}
}

func TestInspectJSONUsesProductionDecoder(t *testing.T) {
	input := `{"org_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","created_by":"user","secrets":[{"name":"x","value":"v","hosts":["a"],"headers":{"A":"{value}"},"placeholder":"p"}]}`
	r, err := decodeTransfer([]byte(input))
	if err != nil || validateTransfer(t.Context(), "Box123456789", &r) != nil {
		t.Fatalf("valid request rejected: %v", err)
	}
}

func TestDecodeValidUnicode(t *testing.T) {
	const input = `{"org_id":"o","created_by":"user","secrets":[{"name":"key","value":"\uD83D\uDE00�\\uD800","headers":{"X-Key":"{value}"}}]}`
	req, err := decodeTransfer([]byte(input))
	if err != nil || req.Secrets[0].Value != `😀�\uD800` {
		t.Fatal("valid Unicode, literal replacement character, or escaped backslash was changed")
	}
}
