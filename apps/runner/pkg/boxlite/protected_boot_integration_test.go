//go:build linux && boxlite_integration

package boxlite_test

import (
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/cmd/runner/config"
	"github.com/boxlite-ai/runner/pkg/api"
	"github.com/boxlite-ai/runner/pkg/api/dto"
	blclient "github.com/boxlite-ai/runner/pkg/boxlite"
	"github.com/boxlite-ai/runner/pkg/runner"
	"golang.org/x/net/dns/dnsmessage"
	"golang.org/x/sys/unix"
)

const (
	bootProxyIP   = "11.23.0.1"
	bootPlainIP   = "11.23.0.2"
	bootInspectIP = "11.23.0.3"
	bootSecretIP  = "11.23.0.4"
	bootDNSIP     = "11.23.0.5"
	bootRunnerID  = "8137cc0d-5d3f-43b8-aa32-b9304740269e"
	bootAPIToken  = "fixture-runner-token"
)

func TestIntegrationProtectedBootRetiresAfterPreSpawnFailure(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 4*time.Minute)
	defer cancel()
	home, err := os.MkdirTemp("/tmp", "pr04-prespawn-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(home) })
	client, err := blclient.NewClient(ctx, blclient.ClientConfig{HomeDir: home})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	const boxID = "597da250-c3f6-4276-a0c2-25657a8fdeda"
	cpu, outbound, skipStart := 1.0, false, true
	nativeID, _, err := client.Create(ctx, dto.CreateBoxDTO{
		Id: boxID, Image: "curlimages/curl:8.12.1", CpuQuota: &cpu, MemoryQuota: 1, StorageQuota: 2,
		OutboundEnabled: &outbound, SkipStart: &skipStart,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(home, "boxes", nativeID, "shim.stderr"), 0o700); err != nil {
		t.Fatal(err)
	}
	attempt := json.RawMessage(`{"runner_id":"8137cc0d-5d3f-43b8-aa32-b9304740269e","attempt_id":"fixture-attempt","registration_id":"fixture-registration","registration_revision":"7","policy":{"revision":"fixture-policy","policy":{"mode":"disabled"}}}`)
	request := json.RawMessage(fmt.Sprintf(`{"key":%s,"scheme":"https","host":"proxy.example.com","port":443,"doh_url":"https://resolver.example.com/dns-query","doh_address":"1.1.1.1:443"}`, attempt))
	_, err = client.ProtectedBoot(ctx, boxID, boxlite.ProtectedBootStart, request)
	if err == nil || !strings.Contains(err.Error(), "Failed to create stderr file") {
		t.Fatalf("expected stderr creation failure before shim spawn, got %v", err)
	}
	receipt, err := client.ProtectedBoot(ctx, boxID, boxlite.ProtectedBootRetire, attempt)
	if err != nil {
		t.Fatalf("retire the admitted attempt without a shim: %v", err)
	}
	var evidence struct{ Epoch, Outcome string }
	if err := json.Unmarshal(receipt, &evidence); err != nil || evidence.Epoch == "" || evidence.Outcome != "retired" {
		t.Fatalf("unexpected retirement evidence: %s (%v)", receipt, err)
	}
}

func TestIntegrationProtectedBootTCPPaths(t *testing.T) {
	certs := os.Getenv("BOXLITE_TEST_PROTECTED_BOOT_TLS")
	if certs == "" {
		t.Skip("set BOXLITE_TEST_PROTECTED_BOOT_TLS on a disposable KVM host with the protected boot fixture")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 4*time.Minute)
	defer cancel()
	cert, key := filepath.Join(certs, "host.pem"), filepath.Join(certs, "host.key")
	var targetMu sync.Mutex
	targets := map[string]int{}
	observe := func(path, host, header string) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			// The fixture proxy binds its outbound connection to bootProxyIP.
			peer, _, _ := net.SplitHostPort(r.RemoteAddr)
			if r.Host != host || r.URL.Path != path || r.Header.Get("Authorization") != header || peer != bootProxyIP ||
				(path == "/secret" && (r.TLS == nil || r.TLS.ServerName != host)) {
				t.Errorf("unexpected target request for %s (host %q, source %q, authorized %t)", path, r.Host, peer, r.Header.Get("Authorization") == header)
				http.Error(w, "unexpected route", http.StatusBadRequest)
				return
			}
			targetMu.Lock()
			targets[path]++
			targetMu.Unlock()
			_, _ = fmt.Fprint(w, strings.TrimPrefix(path, "/"))
		}
	}
	serveProtectedBootFixture(t, bootPlainIP+":80", observe("/plain", bootPlainIP, ""), "", "")
	serveProtectedBootFixture(t, bootInspectIP+":80", observe("/inspect", "inspect.test", ""), "", "")
	serveProtectedBootFixture(t, bootSecretIP+":443", observe("/secret", "protected.test", "Bearer fixture-target-secret"), cert, key)
	serveProtectedBootFixture(t, bootDNSIP+":443", http.HandlerFunc(protectedBootDNS), cert, key)

	var reject atomic.Bool
	var proxyMu sync.Mutex
	connections := map[string]int{}
	const managedDoH = "1.1.1.1:443"
	allowed := map[string]bool{bootPlainIP + ":80": true, bootInspectIP + ":80": true, bootSecretIP + ":443": true, managedDoH: true}
	proxyPort := serveProtectedBootFixture(t, bootProxyIP+":0", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodConnect || !allowed[r.Host] ||
			r.Header.Get("Proxy-Authorization") != "Basic "+base64.StdEncoding.EncodeToString([]byte("fixture-user:fixture-password")) {
			t.Errorf("unexpected proxy operation for %q", r.Host)
			http.Error(w, "unexpected CONNECT", http.StatusForbidden)
			return
		}
		proxyMu.Lock()
		connections[r.Host]++
		proxyMu.Unlock()
		if reject.Load() {
			http.Error(w, "fixture refused CONNECT", http.StatusForbidden)
			return
		}
		dialer := net.Dialer{LocalAddr: &net.TCPAddr{IP: net.ParseIP(bootProxyIP)}, Timeout: 2 * time.Second}
		destination := r.Host
		if destination == managedDoH {
			destination = bootDNSIP + ":443"
		}
		upstream, err := dialer.DialContext(r.Context(), "tcp", destination)
		if err != nil {
			t.Errorf("dial fixture destination %q: %v", r.Host, err)
			http.Error(w, "fixture dial failed", http.StatusBadGateway)
			return
		}
		defer upstream.Close()
		downstream, rw, err := http.NewResponseController(w).Hijack()
		if err != nil {
			t.Errorf("hijack fixture CONNECT: %v", err)
			return
		}
		defer downstream.Close()
		deadline := time.Now().Add(30 * time.Second)
		_ = downstream.SetDeadline(deadline)
		_ = upstream.SetDeadline(deadline)
		if _, err := rw.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil || rw.Flush() != nil {
			return
		}
		relayed := make(chan struct{})
		go func() {
			defer close(relayed)
			_, _ = io.Copy(upstream, rw.Reader)
			_ = upstream.(*net.TCPConn).CloseWrite()
		}()
		_, _ = io.Copy(downstream, upstream)
		_ = downstream.Close()
		<-relayed
	}), "", "")

	home, err := os.MkdirTemp("/tmp", "pr04-vm-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if t.Failed() {
			t.Logf("retained failed fixture runtime: %s", home)
			return
		}
		_ = os.RemoveAll(home)
	})
	client, err := blclient.NewClient(ctx, blclient.ClientConfig{HomeDir: home})
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if client != nil {
			_ = client.Close()
		}
	}()
	const boxID = "597da250-c3f6-4276-a0c2-25657a8fdeda"
	const attemptID = "1eaf8827-d376-4736-acf0-63d6c57b934d"
	attempt := fmt.Sprintf(`{"runner_id":%q,"attempt_id":%q,"registration_id":"fixture-registration","registration_revision":"7","policy":{"revision":"fixture-policy","policy":{"mode":"enabled","allow_net":["11.23.0.2","inspect.test","protected.test"]}}}`, bootRunnerID, attemptID)
	cpu := 1.0
	nativeID, err := client.AllocateProtectedPlaceholder(ctx, dto.CreateBoxDTO{
		Id: boxID, Image: "curlimages/curl:8.12.1", CpuQuota: &cpu, MemoryQuota: 1, StorageQuota: 2,
		Entrypoint: []string{"sleep"}, Cmd: []string{"3600"},
		Secrets: []dto.SecretDTO{{Name: "fixture", Value: "fixture-target-secret", Hosts: []string{"protected.test"}, Headers: map[string]string{"Authorization": "Bearer {value}"}}},
	}, blclient.ProtectedPreparation{
		AttemptID: attemptID, Fingerprint: "fixture-prepare", Authorize: func(context.Context) error { return nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if client == nil {
			return
		}
		cleanup, stop := context.WithTimeout(context.Background(), 15*time.Second)
		defer stop()
		_, err := client.AuthorizedProtectedBoot(cleanup, boxID, attemptID, boxlite.ProtectedBootRetire,
			json.RawMessage(attempt), func(context.Context, string) (blclient.ProtectedBootAdmission, error) {
				return blclient.ProtectedBootAdmission{NativeID: nativeID, StartClaimed: true}, nil
			})
		if err != nil {
			t.Logf("stop fixture Box: %v", err)
		}
	}()
	https, runnerURL := startProtectedBootListener(t, client, cert, key, nativeID)
	path := runnerURL + "/v1/boxes/" + boxID + "/network/outbound/bootstrap"
	request := fmt.Sprintf(`{"key":%s,"scheme":"http","host":%q,"port":%d,"credential":{"username":"fixture-user","password":"fixture-password"}}`, attempt, bootProxyIP, proxyPort)
	for _, tt := range []struct {
		token, runnerID string
		status          int
	}{
		{"wrong-token", bootRunnerID, http.StatusUnauthorized},
		{bootAPIToken, "d02ae8d4-f05c-42f4-bb57-d1fdb71b5d42", http.StatusForbidden},
	} {
		postProtectedBoot(t, ctx, https, path, tt.token, tt.runnerID, request, tt.status)
	}
	_, err = client.AuthorizedProtectedBoot(ctx, boxID, attemptID, boxlite.ProtectedBootRead,
		json.RawMessage(attempt), func(context.Context, string) (blclient.ProtectedBootAdmission, error) {
			return blclient.ProtectedBootAdmission{NativeID: nativeID}, nil
		})
	if !boxlite.IsInvalidState(err) {
		t.Fatalf("denied HTTP requests must leave startup unconfirmed: %v", err)
	}
	receipt := postProtectedBoot(t, ctx, https, path, bootAPIToken, bootRunnerID, request, http.StatusOK)
	var evidence struct{ Epoch, Outcome string }
	if err := json.Unmarshal(receipt, &evidence); err != nil || evidence.Epoch == "" || evidence.Outcome != "confirmed" {
		t.Fatalf("unexpected startup evidence: %s (%v)", receipt, err)
	}
	observed := postProtectedBoot(t, ctx, https, path+"/receipt", bootAPIToken, bootRunnerID, attempt, http.StatusOK)
	if string(observed) != string(receipt) {
		t.Fatalf("read back exact startup evidence: %s", observed)
	}
	guestEnv, err := client.Exec(ctx, boxID, "env")
	if err != nil || guestEnv.ExitCode != 0 {
		t.Fatalf("read Guest environment: %v", err)
	}
	if strings.Contains(guestEnv.StdOut, "fixture-password") || strings.Contains(string(observed), "fixture-password") {
		t.Fatal("proxy credential appeared in a Guest or readback record")
	}

	probe := func(url string, headers ...string) (*blclient.ExecResult, error) {
		// Use the container trust bundle that the Guest agent updates at init.
		args := []string{"--noproxy", "*", "--cacert", "/etc/ssl/certs/ca-certificates.crt",
			"--fail", "--silent", "--show-error", "--max-time", "10"}
		for _, header := range headers {
			args = append(args, "--header", header)
		}
		return client.Exec(ctx, boxID, "curl", append(args, url)...)
	}
	for _, entry := range []struct {
		url, body string
		headers   []string
	}{
		{"http://" + bootPlainIP + "/plain", "plain", nil},
		{"http://inspect.test/inspect", "inspect", nil},
		// MITM only replaces headers the application explicitly sends.
		{"https://protected.test/secret", "secret", []string{"Authorization: Bearer guest-placeholder"}},
	} {
		out, err := probe(entry.url, entry.headers...)
		if err != nil || out.ExitCode != 0 || strings.TrimSpace(out.StdOut) != entry.body {
			t.Fatalf("Guest traffic for %s: %+v (%v)", entry.url, out, err)
		}
		t.Logf("Guest reached %s through the fixture proxy", entry.url)
	}
	proxyMu.Lock()
	for address := range allowed {
		if connections[address] == 0 {
			t.Errorf("registered proxy saw no CONNECT to %s", address)
		}
		t.Logf("proxy received %d CONNECT requests for %s", connections[address], address)
	}
	inspectionConnects := connections[bootInspectIP+":80"]
	proxyMu.Unlock()
	denied, err := probe("http://" + bootInspectIP + "/inspect")
	if err != nil || denied.ExitCode == 0 {
		t.Fatalf("Guest request by unapproved literal IP did not fail: %+v (%v)", denied, err)
	}
	proxyMu.Lock()
	if connections[bootInspectIP+":80"] != inspectionConnects {
		t.Error("unapproved literal IP opened a proxy tunnel")
	}
	proxyMu.Unlock()
	reject.Store(true)
	failed, err := probe("http://" + bootPlainIP + "/plain")
	if err != nil || failed.ExitCode == 0 {
		t.Fatalf("Guest request did not fail after proxy rejection: %+v (%v)", failed, err)
	}
	targetMu.Lock()
	for _, path := range []string{"/plain", "/inspect", "/secret"} {
		if targets[path] != 1 {
			t.Errorf("target %s received %d requests, want one through the proxy", path, targets[path])
		}
	}
	targetMu.Unlock()
	t.Log("policy denial and proxy rejection produced no extra target requests")
	killProtectedFixtureShim(t, home, nativeID)
	if err := client.Close(); err != nil {
		t.Fatal(err)
	}
	client, err = blclient.NewClient(ctx, blclient.ClientConfig{HomeDir: home})
	if err != nil {
		t.Fatal(err)
	}
	retire := func(client *blclient.Client) (json.RawMessage, error) {
		return client.AuthorizedProtectedBoot(ctx, boxID, attemptID, boxlite.ProtectedBootRetire,
			json.RawMessage(attempt), func(context.Context, string) (blclient.ProtectedBootAdmission, error) {
				return blclient.ProtectedBootAdmission{NativeID: nativeID, StartClaimed: true, Epoch: evidence.Epoch}, nil
			})
	}
	retired, err := retire(client)
	if err != nil {
		t.Fatalf("retire after abnormal shim exit: %v", err)
	}
	var cleanup struct {
		Epoch, Outcome   string
		AllocationClosed bool
	}
	if err := json.Unmarshal(retired, &cleanup); err != nil || cleanup.Outcome != "retired" ||
		cleanup.Epoch != evidence.Epoch || !cleanup.AllocationClosed {
		t.Fatalf("retire after launch: %s (%v)", retired, err)
	}
	if err := client.Close(); err != nil {
		t.Fatal(err)
	}
	client = nil
	check, err := json.Marshal(retirementReplayFixture{
		Home: home, BoxID: boxID, AttemptID: attemptID,
		NativeID: nativeID, Epoch: evidence.Epoch, Key: json.RawMessage(attempt), Receipt: retired,
	})
	if err != nil {
		t.Fatal(err)
	}
	worker := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestProtectedRetirementReplayInFreshRunner$")
	worker.Env = append(os.Environ(), "BOXLITE_TEST_PROTECTED_REPLAY="+string(check))
	if output, err := worker.CombinedOutput(); err != nil {
		t.Fatalf("replay retirement in a fresh Runner process: %v\n%s", err, output)
	}
}

type retirementReplayFixture struct {
	Home, BoxID, AttemptID, NativeID, Epoch string
	Key, Receipt                            json.RawMessage
}

func TestProtectedRetirementReplayInFreshRunner(t *testing.T) {
	data := os.Getenv("BOXLITE_TEST_PROTECTED_REPLAY")
	if data == "" {
		t.Skip("requires the protected startup fixture")
	}
	var fixture retirementReplayFixture
	if err := json.Unmarshal([]byte(data), &fixture); err != nil {
		t.Fatal(err)
	}
	if _, err := config.GetConfig(); err != nil {
		t.Fatal(err)
	}
	ctx := t.Context()
	client, err := blclient.NewClient(ctx, blclient.ClientConfig{HomeDir: fixture.Home})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	receipt, err := client.AuthorizedProtectedBoot(ctx, fixture.BoxID, fixture.AttemptID, boxlite.ProtectedBootRetire,
		fixture.Key, func(context.Context, string) (blclient.ProtectedBootAdmission, error) {
			return blclient.ProtectedBootAdmission{
				NativeID: fixture.NativeID, StartClaimed: true, Epoch: fixture.Epoch,
			}, nil
		})
	if err != nil || string(receipt) != string(fixture.Receipt) {
		t.Fatalf("replayed retirement = %s (%v), want %s", receipt, err, fixture.Receipt)
	}
}

func killProtectedFixtureShim(t *testing.T, home, nativeID string) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(home, "boxes", nativeID, "shim.pid"))
	if err != nil {
		t.Fatal(err)
	}
	identity := strings.Fields(string(data))
	if len(identity) < 2 {
		t.Fatal("fixture shim has no process identity")
	}
	pid, err := strconv.Atoi(identity[0])
	if err != nil || pid < 2 {
		t.Fatal("fixture shim PID is invalid")
	}
	fd, err := unix.PidfdOpen(pid, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer unix.Close(fd)
	stat, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		t.Fatal(err)
	}
	fields := strings.Fields(string(stat)[strings.LastIndexByte(string(stat), ')')+1:])
	if len(fields) <= 19 || fields[19] != identity[1] {
		t.Fatal("fixture shim process identity changed")
	}
	if err := unix.PidfdSendSignal(fd, unix.SIGKILL, nil, 0); err != nil {
		t.Fatal(err)
	}
	poll := []unix.PollFd{{Fd: int32(fd), Events: unix.POLLIN}}
	if _, err := unix.Poll(poll, 5000); err != nil || poll[0].Revents&unix.POLLIN == 0 {
		t.Fatalf("fixture shim did not exit: %v", err)
	}
}

func startProtectedBootListener(t *testing.T, runtime *blclient.Client, cert, key, nativeID string) (*http.Client, string) {
	t.Helper()
	controlCert, err := tls.LoadX509KeyPair(cert, key)
	if err != nil {
		t.Fatal(err)
	}
	var claimed atomic.Bool
	control := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+bootAPIToken ||
			r.URL.Path != "/runners/protected-bootstrap/authorize" {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		var message struct {
			Operation string
			NativeID  string `json:"native_id"`
		}
		if json.NewDecoder(r.Body).Decode(&message) != nil ||
			(message.Operation == "start" && (message.NativeID != nativeID || !claimed.CompareAndSwap(false, true))) {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		_ = json.NewEncoder(w).Encode(blclient.ProtectedBootAdmission{
			RunnerID: bootRunnerID, NativeID: nativeID, StartClaimed: claimed.Load(),
		})
	}))
	control.TLS = &tls.Config{Certificates: []tls.Certificate{controlCert}, MinVersion: tls.VersionTLS12}
	control.StartTLS()
	t.Cleanup(control.Close)
	t.Setenv("BOXLITE_LISTEN_HOST", "127.0.0.1")
	t.Setenv("BOXLITE_API_URL", "https://protected.test")
	t.Setenv("BOXLITE_RUNNER_TOKEN", bootAPIToken)
	t.Setenv("RUNNER_DOMAIN", "protected.test")
	t.Setenv("ENVIRONMENT", "production")
	if _, err := config.GetConfig(); err != nil {
		t.Fatal(err)
	}
	if _, err := runner.GetInstance(&runner.RunnerInstanceConfig{Boxlite: runtime}); err != nil {
		t.Fatal(err)
	}
	held, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := held.Addr().String()
	port := held.Addr().(*net.TCPAddr).Port
	if err := held.Close(); err != nil {
		t.Fatal(err)
	}
	server := api.NewApiServer(api.ApiServerConfig{
		Logger: slog.Default(), ApiPort: port, ApiToken: bootAPIToken, ApiVersion: 0,
		EnableTLS: true, TLSCertFile: cert, TLSKeyFile: key,
		ProtectedBoot: api.NewProtectedBootConfig(control.URL, bootAPIToken),
	})
	done := make(chan error, 1)
	go func() { done <- server.Start(t.Context()) }()
	transport := &http.Transport{TLSClientConfig: &tls.Config{ServerName: "protected.test", MinVersion: tls.VersionTLS12}}
	t.Cleanup(transport.CloseIdleConnections)
	https := &http.Client{Transport: transport, Timeout: 2 * time.Minute}
	url := "https://" + address
	startup, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	health, err := http.NewRequestWithContext(startup, http.MethodGet, url+"/", nil)
	if err != nil {
		t.Fatal(err)
	}
	for startup.Err() == nil {
		select {
		case err := <-done:
			t.Fatalf("Runner HTTPS listener failed: %v", err)
		default:
		}
		response, err := https.Do(health)
		if err == nil {
			response.Body.Close()
			t.Cleanup(func() {
				server.Stop()
				if err := <-done; err != http.ErrServerClosed {
					t.Errorf("shutdown Runner HTTPS listener: %v", err)
				}
			})
			if response.StatusCode != http.StatusOK {
				t.Fatalf("Runner HTTPS health status = %d", response.StatusCode)
			}
			return https, url
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("Runner HTTPS listener at %s did not become healthy", address)
	return nil, ""
}

func postProtectedBoot(t *testing.T, ctx context.Context, client *http.Client, url, token, runnerID, payload string, wantStatus int) json.RawMessage {
	t.Helper()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, url, strings.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("X-BoxLite-Runner-Id", runnerID)
	request.Header.Set("X-BoxLite-Bootstrap-Key", base64.RawURLEncoding.EncodeToString(make([]byte, 32)))
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != wantStatus {
		t.Fatalf("protected Runner HTTPS POST returned %d, want %d", response.StatusCode, wantStatus)
	}
	t.Logf("protected Runner HTTPS POST returned %d", response.StatusCode)
	if wantStatus != http.StatusOK {
		return nil
	}
	var body struct{ Receipt json.RawMessage }
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil || len(body.Receipt) == 0 {
		t.Fatalf("read protected Runner HTTPS receipt: %v", err)
	}
	return body.Receipt
}

func serveProtectedBootFixture(t *testing.T, address string, handler http.Handler, cert, key string) int {
	t.Helper()
	listener, err := net.Listen("tcp4", address)
	if err != nil {
		t.Fatalf("bind protected boot fixture %s: %v", address, err)
	}
	server := &http.Server{Handler: handler, ReadHeaderTimeout: 5 * time.Second}
	done := make(chan error, 1)
	go func() {
		if cert != "" {
			done <- server.ServeTLS(listener, cert, key)
		} else {
			done <- server.Serve(listener)
		}
	}()
	t.Cleanup(func() {
		_ = server.Close()
		_ = listener.Close()
		if err := <-done; err != http.ErrServerClosed && err != net.ErrClosed {
			t.Errorf("fixture server %s: %v", address, err)
		}
	})
	return listener.Addr().(*net.TCPAddr).Port
}

func protectedBootDNS(w http.ResponseWriter, r *http.Request) {
	var message dnsmessage.Message
	wire, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 4096))
	if err != nil || message.Unpack(wire) != nil || len(message.Questions) != 1 || r.URL.Path != "/dns-query" {
		http.Error(w, "invalid fixture DNS request", http.StatusBadRequest)
		return
	}
	question := message.Questions[0]
	message.Response = true
	message.RecursionAvailable = true
	if question.Type == dnsmessage.TypeA {
		var ip [4]byte
		switch question.Name.String() {
		case "inspect.test.":
			ip = [4]byte{11, 23, 0, 3}
		case "protected.test.":
			ip = [4]byte{11, 23, 0, 4}
		}
		if ip != [4]byte{} {
			message.Answers = []dnsmessage.Resource{{Header: dnsmessage.ResourceHeader{Name: question.Name, Class: dnsmessage.ClassINET, TTL: 30}, Body: &dnsmessage.AResource{A: ip}}}
		}
	}
	answer, err := message.Pack()
	if err != nil {
		http.Error(w, "invalid fixture DNS reply", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/dns-message")
	_, _ = w.Write(answer)
}
