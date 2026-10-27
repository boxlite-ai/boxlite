package controllers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	sdkboxlite "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/boxlite"
	"github.com/gin-gonic/gin"
)

// sshSecret stands in for private key material; no rejection may repeat it.
const sshSecret = "PRIVATE-KEY-MATERIAL-a1b2c3"

func sshBody(top, account string) string {
	return fmt.Sprintf(`{"listen_address":"0.0.0.0:2222","host_private_key":%q%s,"accounts":[{"login":"alice"%s}]}`,
		sshSecret, top, account)
}

func TestSSHConfigureRejectsMalformedBodiesWithoutEchoingThem(t *testing.T) {
	router := gin.New()
	router.POST("/v1/boxes/:boxId/ssh", BoxliteSSHConfigure)
	for name, body := range map[string]string{
		"invalid JSON":           `{"host_private_key":"` + sshSecret,
		"not an object":          `["` + sshSecret + `"]`,
		"trailing value":         sshBody("", "") + `{}`,
		"missing host key":       `{"listen_address":"0.0.0.0:2222","accounts":[{"login":"` + sshSecret + `"}]}`,
		"case-variant key":       strings.Replace(sshBody("", ""), `"host_private_key"`, `"Host_Private_Key"`, 1),
		"duplicate key":          sshBody(`,"listen_address":"`+sshSecret+`"`, ""),
		"unknown field":          sshBody(`,"extra":"`+sshSecret+`"`, ""),
		"unknown account field":  sshBody("", `,"password":"`+sshSecret+`"`),
		"unknown ca field":       sshBody("", `,"ca":{"public_key":"k","principal":"p","x":"`+sshSecret+`"}`),
		"ca without principal":   sshBody("", `,"ca":{"public_key":"`+sshSecret+`"}`),
		"null listen address":    strings.Replace(sshBody("", ""), `"0.0.0.0:2222"`, `null`, 1),
		"null accounts":          `{"listen_address":"a","host_private_key":"` + sshSecret + `","accounts":null}`,
		"null account":           `{"listen_address":"a","host_private_key":"` + sshSecret + `","accounts":[null]}`,
		"null authorized keys":   sshBody("", `,"authorized_keys":null`),
		"null authorized key":    sshBody("", `,"authorized_keys":[null]`),
		"wrong type":             sshBody("", `,"authorized_keys":"`+sshSecret+`"`),
		"body over the size cap": sshBody("", `,"authorized_keys":["`+strings.Repeat("k", maxSSHConfigBytes)+`"]`),
	} {
		w := httptest.NewRecorder()
		router.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/v1/boxes/box1/ssh", strings.NewReader(body)))
		want := `{"error":{"code":"invalid_argument","message":"invalid SSH configuration","type":"InvalidArgumentError"}}`
		if w.Code != http.StatusBadRequest || w.Body.String() != want {
			t.Errorf("%s: %d %s", name, w.Code, w.Body)
		}
		if strings.Contains(w.Body.String(), sshSecret) {
			t.Errorf("%s: the rejection echoed the request", name)
		}
	}
}

func TestSSHConfigureReadsTheCompleteSchema(t *testing.T) {
	body := sshBody("", `,"ca":{"public_key":"ca-key","principal":"ops"}`)
	body = strings.Replace(body, `]}`, `,{"login":"bob","authorized_keys":["k1","k2"],"ca":null}]}`, 1)

	config, err := parseSSHConfig(strings.NewReader(body))
	if err != nil {
		t.Fatalf("parseSSHConfig: %v", err)
	}
	want := sdkboxlite.SSHConfig{
		ListenAddress:  "0.0.0.0:2222",
		HostPrivateKey: sshSecret,
		Accounts: []sdkboxlite.SSHAccount{
			{Login: "alice", CA: &sdkboxlite.SSHCAConfig{PublicKey: "ca-key", Principal: "ops"}},
			{Login: "bob", AuthorizedKeys: []string{"k1", "k2"}},
		},
	}
	if !reflect.DeepEqual(config, want) {
		t.Fatalf("parsed %#v, want %#v", config, want)
	}
}

func TestSSHAnswersEveryStatusFieldAndKeepsErrorClasses(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status *sdkboxlite.SSHStatus
		err    error
		code   int
		body   string
	}{
		{"disabled status", &sdkboxlite.SSHStatus{}, nil, http.StatusOK,
			`{"enabled":false,"generation":0,"listen_address":"","host_public_key":"","host_key_fingerprint":""}`},
		{"box not running", nil, fmt.Errorf("%w: box1 is paused", boxlite.ErrBoxNotRunning), http.StatusConflict,
			`{"error":{"code":"invalid_state","message":"box is not running: box1 is paused","type":"InvalidStateError"}}`},
		{"missing box", nil, fmt.Errorf("read state of box box1: %w", &sdkboxlite.Error{Code: sdkboxlite.ErrNotFound, Message: "box not found"}),
			http.StatusNotFound, `{"error":{"code":"not_found","message":"box not found","type":"NotFoundError"}}`},
		{"guest RPC failure", nil, &sdkboxlite.Error{Code: sdkboxlite.ErrRpc, Message: "SSH bind failed"}, http.StatusServiceUnavailable,
			`{"error":{"code":"upstream_unavailable","message":"SSH bind failed","type":"UpstreamUnavailableError"}}`},
	} {
		w := httptest.NewRecorder()
		ctx, _ := gin.CreateTestContext(w)
		respondSSH(ctx, tc.status, tc.err)
		if w.Code != tc.code || !jsonEqual(t, w.Body.String(), tc.body) {
			t.Errorf("%s: %d %s, want %d %s", tc.name, w.Code, w.Body, tc.code, tc.body)
		}
	}
}

func jsonEqual(t *testing.T, got, want string) bool {
	t.Helper()
	var a, b any
	if err := json.Unmarshal([]byte(got), &a); err != nil {
		return false
	}
	if err := json.Unmarshal([]byte(want), &b); err != nil {
		t.Fatalf("bad expectation %s: %v", want, err)
	}
	return reflect.DeepEqual(a, b)
}
