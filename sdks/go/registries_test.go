//go:build boxlite_dev

package boxlite

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

const (
	testLoginID  = "0aaa0000-0000-4000-8000-000000000001"
	testPassword = "not-a-real-token"
	testLogin    = `{"id":"0aaa0000-0000-4000-8000-000000000001","registry_host":"ghcr.io",` +
		`"repository_prefix":"acme/","username":"acme-bot","created_by":null,` +
		`"created_at":"2026-09-01T00:00:00Z"}`
)

type registryReply struct {
	status int
	body   string
}

type registryRequest struct {
	route string
	body  string
}

// registryServer answers the box API's registry routes with the replies a
// test sets, keyed by method and raw request target, and records each request.
type registryServer struct {
	*httptest.Server
	mu       sync.Mutex
	replies  map[string]registryReply
	requests []registryRequest
}

func newRegistryServer(t *testing.T) *registryServer {
	t.Helper()
	server := &registryServer{replies: map[string]registryReply{}}
	server.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		route := r.Method + " " + r.RequestURI
		server.mu.Lock()
		server.requests = append(server.requests, registryRequest{route: route, body: string(body)})
		reply, ok := server.replies[route]
		server.mu.Unlock()
		if !ok {
			http.NotFound(w, r)
			return
		}
		if reply.body == "" {
			w.WriteHeader(reply.status)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(reply.status)
		_, _ = io.WriteString(w, reply.body)
	}))
	t.Cleanup(server.Close)
	return server
}

func (s *registryServer) reply(route string, status int, body string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.replies[route] = registryReply{status: status, body: body}
}

func (s *registryServer) received() []registryRequest {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]registryRequest(nil), s.requests...)
}

// registries opens the registry handle of a REST runtime on the server.
func (s *registryServer) registries(t *testing.T) *Registries {
	t.Helper()
	rt, err := NewRest(BoxliteRestOptions{URL: s.URL})
	if err != nil {
		t.Fatalf("NewRest: %v", err)
	}
	t.Cleanup(func() {
		if err := rt.Close(); err != nil {
			t.Errorf("Close runtime: %v", err)
		}
	})
	registries, err := rt.Registries()
	if err != nil {
		t.Fatalf("Registries: %v", err)
	}
	t.Cleanup(func() { _ = registries.Close() })
	return registries
}

func registryTestContext(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(cancel)
	return ctx
}

func testNewLogin() NewRegistryCredential {
	return NewRegistryCredential{
		RegistryHost:     "ghcr.io",
		RepositoryPrefix: "acme/",
		Username:         "acme-bot",
		Password:         testPassword,
	}
}

func TestRestRegistriesListReadsEachLogin(t *testing.T) {
	server := newRegistryServer(t)
	server.reply("GET /v1/registries", http.StatusOK, `{"registries":[`+testLogin+`]}`)

	logins, err := server.registries(t).List(registryTestContext(t))
	if err != nil {
		t.Fatalf("List: %v", err)
	}

	want := RegistryCredential{
		ID:               testLoginID,
		RegistryHost:     "ghcr.io",
		RepositoryPrefix: "acme/",
		Username:         "acme-bot",
		CreatedAt:        time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC),
	}
	if len(logins) != 1 || logins[0] != want {
		t.Fatalf("List: got %+v, want [%+v]", logins, want)
	}
}

// A broken server that echoed the password back would still not hand it on:
// RegistryCredential has no field for it.
func TestRestRegistriesCreateSendsTheLoginAndHandsBackNoPassword(t *testing.T) {
	server := newRegistryServer(t)
	echoed := strings.Replace(testLogin, "{", `{"password":"`+testPassword+`",`, 1)
	server.reply("POST /v1/registries", http.StatusCreated, echoed)

	created, err := server.registries(t).Create(registryTestContext(t), testNewLogin())
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	requests := server.received()
	var sent map[string]string
	if err := json.Unmarshal([]byte(requests[0].body), &sent); err != nil {
		t.Fatalf("request body: %v", err)
	}
	want := map[string]string{
		"registry_host": "ghcr.io", "repository_prefix": "acme/",
		"username": "acme-bot", "password": testPassword,
	}
	if fmt.Sprint(sent) != fmt.Sprint(want) {
		t.Errorf("sent %v, want %v", sent, want)
	}
	if created.ID != testLoginID {
		t.Errorf("ID: got %q", created.ID)
	}
	if strings.Contains(fmt.Sprintf("%#v", created), testPassword) {
		t.Error("the created login carries the password")
	}
}

func TestRestRegistriesCreateWithoutAPrefixSendsNone(t *testing.T) {
	server := newRegistryServer(t)
	server.reply("POST /v1/registries", http.StatusCreated, testLogin)
	login := testNewLogin()
	login.RepositoryPrefix = ""

	if _, err := server.registries(t).Create(registryTestContext(t), login); err != nil {
		t.Fatalf("Create: %v", err)
	}

	if body := server.received()[0].body; strings.Contains(body, "repository_prefix") {
		t.Errorf("body %s names a prefix; the login covers the whole registry", body)
	}
}

func TestRestRegistriesCreateForAHeldPrefixIsAlreadyExists(t *testing.T) {
	server := newRegistryServer(t)
	server.reply("POST /v1/registries", http.StatusConflict,
		`{"statusCode":409,"message":"A credential for ghcr.io/acme/ already exists","code":"already_exists"}`)

	_, err := server.registries(t).Create(registryTestContext(t), testNewLogin())

	requireErrorCode(t, err, ErrAlreadyExists, "already exists")
}

func TestRestRegistriesRemoveDeletesTheLoginByID(t *testing.T) {
	server := newRegistryServer(t)
	server.reply("DELETE /v1/registries/"+testLoginID, http.StatusNoContent, "")

	if err := server.registries(t).Remove(registryTestContext(t), testLoginID); err != nil {
		t.Fatalf("Remove: %v", err)
	}

	if got := server.received(); len(got) != 1 || got[0].route != "DELETE /v1/registries/"+testLoginID {
		t.Fatalf("requests: %+v", got)
	}
}

func TestRestRegistriesRemoveOfALoginInUseIsInvalidState(t *testing.T) {
	server := newRegistryServer(t)
	server.reply("DELETE /v1/registries/"+testLoginID, http.StatusConflict,
		`{"statusCode":409,"message":"cannot be removed while 1 box(es) pull through it: box-1"}`)

	err := server.registries(t).Remove(registryTestContext(t), testLoginID)

	requireErrorCode(t, err, ErrInvalidState, "box-1")
}

func TestRestRegistriesRemoveRefusesAnIDThatIsNotAUUIDWithoutARequest(t *testing.T) {
	server := newRegistryServer(t)

	err := server.registries(t).Remove(registryTestContext(t), "../images")

	requireErrorCode(t, err, ErrInvalidArgument, "UUID")
	if got := server.received(); len(got) != 0 {
		t.Fatalf("requests sent: %+v", got)
	}
}

func TestRegistriesAreUnsupportedOnALocalRuntime(t *testing.T) {
	_, err := newImageTestRuntime(t).Registries()

	requireErrorCode(t, err, ErrUnsupported, "image_registries")
}

func TestNewRegistryCredentialPrintsWithoutItsPassword(t *testing.T) {
	login := testNewLogin()
	for _, verb := range []string{"%v", "%+v", "%#v", "%s"} {
		printed := fmt.Sprintf(verb, login)
		if strings.Contains(printed, testPassword) {
			t.Errorf("%s printed the password: %s", verb, printed)
		}
		if !strings.Contains(printed, "acme-bot") {
			t.Errorf("%s left out the username: %s", verb, printed)
		}
	}
}
