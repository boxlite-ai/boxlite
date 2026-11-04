package boxlite

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sync"
	"testing"
	"time"
)

// A loopback server answers the box API's domain routes, so what the test
// reads back, and what the server saw, crossed the C binding and the REST
// client.
func TestDomainsUseTheOrganizationRoutes(t *testing.T) {
	const bound = `{"hostname":"demo1.app.test","url":"https://demo1.app.test",
		"target":{"type":"box","box":"AbCdEf123456","port":3000}}`
	const appBound = `{"hostname":"shop1.app.test","url":"https://shop1.app.test","target":{"type":"app","app":"shop"}}`
	replies := map[string]string{
		"GET /v1/domains": `{"domains":[` + bound + `,{"hostname":"spare.app.test",
			"url":"https://spare.app.test","target":null}],"limit":2,"used":2,"remaining":0,"min_length":5}`,
		"PUT /v1/domains/demo1.app.test/target":    bound,
		"PUT /v1/domains/shop1.app.test/target":    appBound,
		"DELETE /v1/domains/demo1.app.test/target": "",
	}
	var mu sync.Mutex
	var seen []string
	var bindBody map[string]any
	var appBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		route := r.Method + " " + r.URL.Path
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		seen = append(seen, route)
		if r.Method == http.MethodPut && r.URL.Path == "/v1/domains/demo1.app.test/target" {
			_ = json.Unmarshal(body, &bindBody)
		}
		if r.Method == http.MethodPut && r.URL.Path == "/v1/domains/shop1.app.test/target" {
			_ = json.Unmarshal(body, &appBody)
		}
		mu.Unlock()
		reply, ok := replies[route]
		switch {
		case !ok:
			http.NotFound(w, r)
		case reply == "":
			w.WriteHeader(http.StatusNoContent)
		default:
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, reply)
		}
	}))
	defer server.Close()

	rt, err := NewRest(BoxliteRestOptions{URL: server.URL})
	if err != nil {
		t.Fatalf("NewRest: %v", err)
	}
	defer rt.Close()
	domains, err := rt.Domains()
	if err != nil {
		t.Fatalf("Domains: %v", err)
	}
	defer domains.Close()
	ctx := context.Background()

	held, err := domains.List(ctx)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(held.Domains) != 2 || held.Domains[1].Target != nil || held.MinLength != 5 {
		t.Fatalf("List = %+v", held)
	}
	got, err := domains.Bind(ctx, "demo1.app.test", DomainTarget{Type: DomainTargetBox, Box: "web-a", Port: 3000})
	if err != nil {
		t.Fatalf("Bind: %v", err)
	}
	want := DomainTarget{Type: DomainTargetBox, Box: "AbCdEf123456", Port: 3000}
	if got.URL != "https://demo1.app.test" || got.Target == nil || *got.Target != want {
		t.Fatalf("Bind = %+v", got)
	}
	if err := domains.Unbind(ctx, "demo1.app.test"); err != nil {
		t.Fatalf("Unbind: %v", err)
	}
	if err := domains.Unbind(ctx, "demo1"); err == nil {
		t.Fatal("Unbind accepted a bare label")
	}
	app, err := domains.Bind(ctx, "shop1.app.test", DomainTarget{Type: DomainTargetApp, App: "shop"})
	if err != nil || app.Target == nil || *app.Target != (DomainTarget{Type: DomainTargetApp, App: "shop"}) {
		t.Fatalf("App bind = %+v, %v", app, err)
	}

	mu.Lock()
	defer mu.Unlock()
	if !reflect.DeepEqual(bindBody, map[string]any{"type": "box", "box": "web-a", "port": float64(3000)}) {
		t.Errorf("bind body = %v", bindBody)
	}
	if !reflect.DeepEqual(appBody, map[string]any{"type": "app", "app": "shop"}) {
		t.Errorf("app body = %v", appBody)
	}
	wantRoutes := []string{"GET /v1/domains", "PUT /v1/domains/demo1.app.test/target", "DELETE /v1/domains/demo1.app.test/target", "PUT /v1/domains/shop1.app.test/target"}
	if !reflect.DeepEqual(seen, wantRoutes) {
		t.Errorf("routes = %v, want %v", seen, wantRoutes)
	}
}

func TestDomainsRejectAClosedHandleAndAnUnknownTargetType(t *testing.T) {
	var domains *Domains
	if _, err := domains.List(context.Background()); !IsInvalidState(err) {
		t.Fatalf("List on nil handle: %v", err)
	}
	if _, err := (&Domains{}).Bind(context.Background(), "demo", DomainTarget{Type: "app", Box: "shop"}); err == nil {
		t.Fatal("Bind accepted Box fields for an App target")
	}
	if _, err := (&Domains{}).Bind(context.Background(), "demo", DomainTarget{Type: "other"}); err == nil || err.Error() != `unsupported domain target type "other"` {
		t.Fatalf("Bind unknown target type: %v", err)
	}
}

// Observe the initial cancellation check before allowing the caller to wait
// for the domain mutex. Capturing Err first keeps cancellation deterministic.
type observedDomainContext struct {
	context.Context
	once    sync.Once
	checked chan struct{}
}

func (c *observedDomainContext) Err() error {
	err := c.Context.Err()
	c.once.Do(func() { close(c.checked) })
	return err
}

func TestDomainsCancelWhileWaitingForAnotherCall(t *testing.T) {
	requests := make(chan struct{}, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests <- struct{}{}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"domains":[],"limit":2,"used":0,"remaining":2,"min_length":5}`)
	}))
	defer server.Close()
	runtime, err := NewRest(BoxliteRestOptions{URL: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Close()
	domains, err := runtime.Domains()
	if err != nil {
		t.Fatal(err)
	}
	defer domains.Close()
	base, cancel := context.WithCancel(context.Background())
	defer cancel()
	ctx := &observedDomainContext{Context: base, checked: make(chan struct{})}
	domains.mu.Lock()
	unlock := sync.OnceFunc(domains.mu.Unlock)
	defer unlock()
	result := make(chan error, 1)
	go func() {
		_, err := domains.List(ctx)
		result <- err
	}()
	select {
	case <-ctx.checked:
	case <-time.After(5 * time.Second):
		t.Fatal("List did not check cancellation")
	}
	cancel()
	unlock()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("List after cancellation = %v, want context.Canceled", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("cancelled List did not return")
	}
	select {
	case <-requests:
		t.Fatal("cancelled List reached the API")
	default:
	}
}
