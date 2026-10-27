//go:build boxlite_dev

package boxlite

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"reflect"
	"runtime/cgo"
	"strings"
	"sync"
	"testing"
	"time"
)

// These tests drive the SDK across real Go -> C -> Rust boundaries into a
// loopback box API, so request bodies and statuses are produced by the
// native REST client rather than by the test.

const (
	sshRestBoxID   = "box1"
	sshRestRoute   = "/v1/boxes/" + sshRestBoxID + "/ssh"
	sshHostKey     = "-----BEGIN OPENSSH PRIVATE KEY-----\nHOSTLEAKCHECK\n"
	sshUserKey     = "ssh-ed25519 AAAAUSERLEAKCHECK user@test"
	sshCAKey       = "ssh-ed25519 AAAACALEAKCHECK ca@test"
	sshCAPrincipal = "PRINCIPALLEAKCHECK"
)

var sshRestStatus = `{"enabled":true,"generation":18446744073709551615,` +
	`"listen_address":"0.0.0.0:2222","host_public_key":"ssh-ed25519 AAAAhost",` +
	`"host_key_fingerprint":"SHA256:abc"}`

type sshRequest struct {
	method, path, body string
}

type sshReply struct {
	status int
	body   string
}

// sshServer answers the box lookup and fixed replies for the SSH route.
type sshServer struct {
	*httptest.Server
	mu       sync.Mutex
	replies  map[string]sshReply
	requests []sshRequest
	// Set by hold: each SSH request is reported on arrived, then kept open
	// until release closes.
	arrived chan struct{}
	release chan struct{}
}

func newSSHServer(t *testing.T) *sshServer {
	t.Helper()
	server := &sshServer{replies: map[string]sshReply{}}
	server.Server = httptest.NewServer(http.HandlerFunc(server.serve))
	t.Cleanup(server.Close)
	return server
}

func (s *sshServer) serve(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method == http.MethodGet && r.URL.Path == "/v1/boxes/"+sshRestBoxID {
		_, _ = io.WriteString(w, `{"box_id":"box1","name":"ssh","status":"running",`+
			`"created_at":"2026-10-27T00:00:00Z","updated_at":"2026-10-27T00:00:00Z",`+
			`"pid":null,"image":"alpine:3.20","cpus":1,"memory_mib":256}`)
		return
	}
	body, _ := io.ReadAll(r.Body)
	s.mu.Lock()
	s.requests = append(s.requests, sshRequest{r.Method, r.URL.Path, string(body)})
	reply, ok := s.replies[r.Method+" "+r.URL.Path]
	arrived, release := s.arrived, s.release
	s.mu.Unlock()
	if arrived != nil {
		arrived <- struct{}{}
		<-release
	}
	if !ok {
		reply = sshReply{http.StatusNotFound, `{"error":{"code":"not_found","message":"no route"}}`}
	}
	w.WriteHeader(reply.status)
	_, _ = io.WriteString(w, reply.body)
}

func (s *sshServer) answer(method string, reply sshReply) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.replies[method+" "+sshRestRoute] = reply
}

func (s *sshServer) answerAll(reply sshReply) {
	for _, method := range []string{http.MethodPost, http.MethodGet, http.MethodDelete} {
		s.answer(method, reply)
	}
}

func (s *sshServer) hold(t *testing.T) (arrived <-chan struct{}, release func()) {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	s.arrived = make(chan struct{}, 4)
	s.release = make(chan struct{})
	var once sync.Once
	releaseFn := func() { once.Do(func() { close(s.release) }) }
	t.Cleanup(releaseFn)
	return s.arrived, releaseFn
}

func (s *sshServer) received() []sshRequest {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]sshRequest(nil), s.requests...)
}

// box opens a REST runtime against the server and attaches box1.
func (s *sshServer) box(t *testing.T) *Box {
	t.Helper()
	rt, err := NewRest(BoxliteRestOptions{URL: s.URL})
	if err != nil {
		t.Fatalf("NewRest: %v", err)
	}
	t.Cleanup(func() { _ = rt.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	box, err := rt.Get(ctx, sshRestBoxID)
	if err != nil {
		t.Fatalf("Get box: %v", err)
	}
	t.Cleanup(func() { _ = box.Close() })
	return box
}

func sshTestConfig() SSHConfig {
	return SSHConfig{
		ListenAddress:  "0.0.0.0:2222",
		HostPrivateKey: sshHostKey,
		Accounts: []SSHAccount{
			{Login: "alice", AuthorizedKeys: []string{sshUserKey}},
			{Login: "bob", CA: &SSHCAConfig{PublicKey: sshCAKey, Principal: sshCAPrincipal}},
		},
	}
}

var sshOperations = []struct {
	name   string
	method string
	call   func(*SSH, context.Context) (*SSHStatus, error)
}{
	{"configure", http.MethodPost, func(ssh *SSH, ctx context.Context) (*SSHStatus, error) {
		return ssh.Configure(ctx, sshTestConfig())
	}},
	{"status", http.MethodGet, (*SSH).Status},
	{"disable", http.MethodDelete, (*SSH).Disable},
}

func sshTestContext(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(cancel)
	return ctx
}

func waitForSSH[T any](t *testing.T, ch <-chan T, what string) T {
	t.Helper()
	select {
	case value := <-ch:
		return value
	case <-time.After(5 * time.Second):
		t.Fatalf("timed out waiting for %s", what)
		panic("unreachable")
	}
}

func requireNoSSHFree(t *testing.T, freed <-chan struct{}) {
	t.Helper()
	select {
	case <-freed:
		t.Fatal("a native status was freed twice")
	case <-time.After(200 * time.Millisecond):
	}
}

func TestRestSSHSendsEachOperationAsOneRequest(t *testing.T) {
	server := newSSHServer(t)
	server.answerAll(sshReply{http.StatusOK, sshRestStatus})
	// Disabling keeps the generation and clears the listener identity.
	server.answer(http.MethodDelete, sshReply{http.StatusOK, `{"enabled":false,` +
		`"generation":18446744073709551615,"listen_address":"","host_public_key":"",` +
		`"host_key_fingerprint":""}`})
	ssh := server.box(t).SSH()
	enabled := &SSHStatus{
		Enabled:            true,
		Generation:         math.MaxUint64,
		ListenAddress:      "0.0.0.0:2222",
		HostPublicKey:      "ssh-ed25519 AAAAhost",
		HostKeyFingerprint: "SHA256:abc",
	}
	wants := map[string]*SSHStatus{
		"configure": enabled,
		"status":    enabled,
		"disable":   {Generation: math.MaxUint64},
	}

	for _, op := range sshOperations {
		got, err := op.call(ssh, sshTestContext(t))
		if err != nil {
			t.Fatalf("%s: %v", op.name, err)
		}
		if want := wants[op.name]; !reflect.DeepEqual(got, want) {
			t.Fatalf("%s status: got %+v, want %+v", op.name, got, want)
		}
	}

	requests := server.received()
	if len(requests) != 3 {
		t.Fatalf("requests: got %d, want 3: %+v", len(requests), requests)
	}
	for i, op := range sshOperations {
		if requests[i].method != op.method || requests[i].path != sshRestRoute {
			t.Errorf("%s request: got %s %s", op.name, requests[i].method, requests[i].path)
		}
	}
	var body any
	if err := json.Unmarshal([]byte(requests[0].body), &body); err != nil {
		t.Fatalf("configure body: %v", err)
	}
	wantBody := map[string]any{
		"listen_address":   "0.0.0.0:2222",
		"host_private_key": sshHostKey,
		"accounts": []any{
			map[string]any{"login": "alice", "authorized_keys": []any{sshUserKey}, "ca": nil},
			map[string]any{"login": "bob", "authorized_keys": []any{},
				"ca": map[string]any{"public_key": sshCAKey, "principal": sshCAPrincipal}},
		},
	}
	if !reflect.DeepEqual(body, wantBody) {
		t.Errorf("configure body:\n got %v\nwant %v", body, wantBody)
	}
}

func TestSSHConfigEncodesTheNativeContract(t *testing.T) {
	body, err := encodeSSHConfig(SSHConfig{
		ListenAddress:  "0.0.0.0:2222",
		HostPrivateKey: "host",
		Accounts: []SSHAccount{
			{Login: "alice"},
			{Login: "bob", AuthorizedKeys: []string{"k"}, CA: &SSHCAConfig{PublicKey: "ca", Principal: "p"}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"listen_address":"0.0.0.0:2222","host_private_key":"host","accounts":[` +
		`{"login":"alice","authorized_keys":[]},` +
		`{"login":"bob","authorized_keys":["k"],"ca":{"public_key":"ca","principal":"p"}}]}`
	if string(body) != want {
		t.Errorf("got  %s\nwant %s", body, want)
	}

	empty, err := encodeSSHConfig(SSHConfig{})
	if err != nil {
		t.Fatal(err)
	}
	if want := `{"listen_address":"","host_private_key":"","accounts":[]}`; string(empty) != want {
		t.Errorf("empty config: got %s, want %s", empty, want)
	}
}

func TestSSHConfigPrintingRedactsCredentials(t *testing.T) {
	config := sshTestConfig()
	values := map[string]any{
		"config":         config,
		"config pointer": &config,
		"account":        config.Accounts[1],
		"ca":             *config.Accounts[1].CA,
	}
	for name, value := range values {
		for _, verb := range []string{"%v", "%+v", "%s", "%#v"} {
			printed := fmt.Sprintf(verb, value)
			for _, secret := range []string{"LEAKCHECK", sshCAPrincipal} {
				if strings.Contains(printed, secret) {
					t.Errorf("%s with %s leaks %q: %s", name, verb, secret, printed)
				}
			}
		}
	}
	want := `SSHConfig{ListenAddress:"0.0.0.0:2222" HostPrivateKey:[redacted] Accounts:[` +
		`SSHAccount{Login:"alice" AuthorizedKeys:[redacted] CA:<nil>} ` +
		`SSHAccount{Login:"bob" AuthorizedKeys:[redacted] CA:[redacted]}]}`
	if got := fmt.Sprintf("%+v", config); got != want {
		t.Errorf("got  %s\nwant %s", got, want)
	}
}

func TestRestSSHCarriesTheServersRefusal(t *testing.T) {
	tests := []struct {
		name     string
		reply    sshReply
		wantCode ErrorCode
	}{
		{"invalid argument", sshReply{http.StatusBadRequest,
			`{"error":{"code":"invalid_argument","message":"invalid SSH configuration"}}`}, ErrInvalidArgument},
		{"not found", sshReply{http.StatusNotFound,
			`{"error":{"code":"not_found","message":"no ssh listener"}}`}, ErrNotFound},
		{"invalid state", sshReply{http.StatusConflict,
			`{"error":{"code":"invalid_state","message":"box is spent"}}`}, ErrInvalidState},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := newSSHServer(t)
			server.answerAll(test.reply)
			ssh := server.box(t).SSH()
			for _, op := range sshOperations {
				status, err := op.call(ssh, sshTestContext(t))
				var e *Error
				if status != nil || !errors.As(err, &e) || e.Code != test.wantCode {
					t.Fatalf("%s: got (%v, %v), want code %d", op.name, status, err, test.wantCode)
				}
				if strings.Contains(err.Error(), "LEAKCHECK") {
					t.Errorf("%s error exposes key material: %v", op.name, err)
				}
			}
		})
	}
}

func TestRestSSHCallGivesUpWhenItsContextEnds(t *testing.T) {
	for _, op := range sshOperations {
		t.Run(op.name, func(t *testing.T) {
			// Registered before the runtime, so its cleanup restores the
			// native free only after the drain loop stops.
			freed, restore := countSSHStatusFrees()
			t.Cleanup(restore)
			server := newSSHServer(t)
			server.answerAll(sshReply{http.StatusOK, sshRestStatus})
			arrived, release := server.hold(t)
			ssh := server.box(t).SSH()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()

			result := make(chan error, 1)
			go func() {
				_, err := op.call(ssh, ctx)
				result <- err
			}()
			waitForSSH(t, arrived, "the request to reach the server")
			cancel()
			if err := waitForSSH(t, result, "the call to return"); !errors.Is(err, context.Canceled) {
				t.Fatalf("got %v, want context.Canceled", err)
			}

			// The abandoned call's late status is still freed, exactly once.
			release()
			waitForSSH(t, freed, "the late status to be freed")
			requireNoSSHFree(t, freed)
			if _, err := ssh.Status(sshTestContext(t)); err != nil {
				t.Fatalf("Status after an abandoned %s: %v", op.name, err)
			}
		})
	}
}

func TestRestSSHReturnsRuntimeClosedWhenTheRuntimeCloses(t *testing.T) {
	for _, op := range sshOperations {
		t.Run(op.name, func(t *testing.T) {
			server := newSSHServer(t)
			arrived, _ := server.hold(t)
			box := server.box(t)
			ssh := box.SSH()

			result := make(chan error, 1)
			go func() {
				_, err := op.call(ssh, context.Background())
				result <- err
			}()
			waitForSSH(t, arrived, "the request to reach the server")
			if err := box.runtime.Close(); err != nil {
				t.Fatalf("Close runtime: %v", err)
			}
			if err := waitForSSH(t, result, "the call to return"); !errors.Is(err, ErrRuntimeClosed) {
				t.Fatalf("pending call: got %v, want ErrRuntimeClosed", err)
			}

			sent := len(server.received())
			if _, err := op.call(ssh, context.Background()); !errors.Is(err, ErrRuntimeClosed) {
				t.Fatalf("call after close: got %v, want ErrRuntimeClosed", err)
			}
			if got := len(server.received()); got != sent {
				t.Errorf("call after close sent %d request(s)", got-sent)
			}
		})
	}
}

func TestRestSSHRefusesWithoutARequest(t *testing.T) {
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	tests := []struct {
		name    string
		prepare func(*Box) context.Context
		check   func(*testing.T, error)
	}{
		{"closed box", func(box *Box) context.Context {
			_ = box.Close()
			return context.Background()
		}, func(t *testing.T, err error) { requireErrorCode(t, err, ErrInvalidState, "box is closed") }},
		{"canceled context", func(*Box) context.Context { return canceled },
			func(t *testing.T, err error) {
				if !errors.Is(err, context.Canceled) {
					t.Fatalf("got %v, want context.Canceled", err)
				}
			}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := newSSHServer(t)
			server.answerAll(sshReply{http.StatusOK, sshRestStatus})
			box := server.box(t)
			ctx := test.prepare(box)
			for _, op := range sshOperations {
				status, err := op.call(box.SSH(), ctx)
				if status != nil {
					t.Errorf("%s: got status %+v", op.name, status)
				}
				test.check(t, err)
			}
			if got := server.received(); len(got) != 0 {
				t.Errorf("requests: got %+v, want none", got)
			}
		})
	}
}

// A completion whose handle cannot deliver still frees the status it owns.
func TestRestSSHCallbackFreesTheStatusItCannotDeliver(t *testing.T) {
	tests := []struct {
		name     string
		userData func() (data any, cleanup func())
	}{
		{"zero handle", func() (any, func()) { return nil, func() {} }},
		{"claim already taken", func() (any, func()) {
			h := registerHandleForDispatch(cgo.NewHandle(make(chan sshStatusResult, 1)))
			claimHandleForDispatch(h) // as Runtime.Close's branch does
			return h, h.Delete
		}},
		{"unexpected channel type", func() (any, func()) {
			h := registerHandleForDispatch(cgo.NewHandle(make(chan error, 1)))
			return h, func() {}
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			// Registered before the runtime, so its cleanup restores the
			// native free only after the drain loop stops.
			freed, restore := countSSHStatusFrees()
			t.Cleanup(restore)
			server := newSSHServer(t)
			server.answerAll(sshReply{http.StatusOK, sshRestStatus})
			box := server.box(t)
			data, cleanup := test.userData()
			defer cleanup()

			var err error
			if h, ok := data.(cgo.Handle); ok {
				err = submitSSHStatus(box, handleToPtr(h))
			} else {
				err = submitSSHStatus(box, nil)
			}
			if err != nil {
				t.Fatalf("submit: %v", err)
			}

			waitForSSH(t, freed, "the undeliverable status to be freed")
			requireNoSSHFree(t, freed)
		})
	}
}
