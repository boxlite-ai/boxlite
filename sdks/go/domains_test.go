package boxlite

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sync"
	"testing"
)

// A loopback server answers the box API's domain routes, so what the test
// reads back, and what the server saw, crossed the C binding and the REST
// client.
func TestDomainsUseTheOrganizationRoutes(t *testing.T) {
	const bound = `{"name":"demo1","hostname":"demo1.app.test","url":"https://demo1.app.test",
		"target":{"type":"box","box":"AbCdEf123456","port":3000}}`
	replies := map[string]string{
		"GET /v1/domains": `{"domains":[` + bound + `,{"name":"spare","hostname":"spare.app.test",
			"url":"https://spare.app.test","target":null}],"limit":2,"used":2,"remaining":0,"min_length":5}`,
		"PUT /v1/domains/demo1/target":    bound,
		"DELETE /v1/domains/demo1/target": "",
	}
	var mu sync.Mutex
	var seen []string
	var bindBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		route := r.Method + " " + r.URL.Path
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		seen = append(seen, route)
		if r.Method == http.MethodPut {
			_ = json.Unmarshal(body, &bindBody)
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
	got, err := domains.Bind(ctx, "demo1", DomainTarget{Type: DomainTargetBox, Box: "web-a", Port: 3000})
	if err != nil {
		t.Fatalf("Bind: %v", err)
	}
	want := DomainTarget{Type: DomainTargetBox, Box: "AbCdEf123456", Port: 3000}
	if got.URL != "https://demo1.app.test" || got.Target == nil || *got.Target != want {
		t.Fatalf("Bind = %+v", got)
	}
	if err := domains.Unbind(ctx, "demo1"); err != nil {
		t.Fatalf("Unbind: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	if !reflect.DeepEqual(bindBody, map[string]any{"type": "box", "box": "web-a", "port": float64(3000)}) {
		t.Errorf("bind body = %v", bindBody)
	}
	wantRoutes := []string{"GET /v1/domains", "PUT /v1/domains/demo1/target", "DELETE /v1/domains/demo1/target"}
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
		t.Fatal("Bind accepted an unknown target type")
	}
}
