package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/boxlite/gvproxy-bridge/internal/guardinventory"
	"github.com/containers/gvisor-tap-vsock/pkg/types"
)

func testCloudInventory(resolvers []string) guardinventory.Document {
	return guardinventory.Document{
		Version: 1, Revision: "inventory-1", ExpiresAt: time.Now().UTC().Add(time.Hour),
		ProtectedNetworks: guardinventory.Networks{
			Node: []string{}, ControlPlane: []string{}, Metadata: []string{}, Services: []string{},
		},
		ResolverEndpoints: resolvers,
	}
}

func writeCloudInventory(t *testing.T, dir string, doc guardinventory.Document) {
	t.Helper()
	bytes, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, guardinventory.FileName)
	replacement := path + ".replacement"
	if err := os.WriteFile(replacement, bytes, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(replacement, path); err != nil {
		t.Fatal(err)
	}
}

func TestCloudInventoryCanonicalizesProtectedNetworksAndHostAddresses(t *testing.T) {
	doc := testCloudInventory([]string{"[::ffff:192.0.2.53]:53"})
	doc.ProtectedNetworks.Node = []string{" 203.0.113.99/24 ", "203.0.113.0/24", "::ffff:198.51.100.3/120"}
	dir := t.TempDir()
	writeCloudInventory(t, dir, doc)
	read := func(hosts ...string) guardinventory.Observation {
		t.Helper()
		raw, err := os.ReadFile(filepath.Join(dir, guardinventory.FileName))
		if err != nil {
			t.Fatal(err)
		}
		var addrs []net.Addr
		for _, host := range hosts {
			addrs = append(addrs, &net.IPAddr{IP: net.ParseIP(host)})
		}
		inventory, err := guardinventory.Parse(raw, time.Now(), addrs)
		if err != nil {
			t.Fatal(err)
		}
		return inventory
	}
	first := read("203.0.114.10", "::ffff:203.0.114.10", "2001:db8::1")
	doc.ResolverEndpoints = []string{"192.0.2.53:53"}
	doc.ProtectedNetworks.Node = []string{"198.51.100.0/24", "203.0.113.0/24"}
	writeCloudInventory(t, dir, doc)
	reordered := read("2001:db8::1", "203.0.114.10")
	if first.Digest != reordered.Digest || len(first.HostAddrs) != 2 || first.HostAddrs[1] != "203.0.114.10" {
		t.Fatalf("normalization changed identity: first=%x reordered=%x hosts=%v", first.Digest, reordered.Digest, first.HostAddrs)
	}
	doc.ProtectedNetworks.Node = nil
	writeCloudInventory(t, dir, doc)
	if _, err := guardinventory.Sample(t.Context(), dir); err == nil {
		t.Fatal("missing protected network category was accepted")
	}
}

func TestCloudInventoryRejectsExpiredMissingAndSymlinkAuthority(t *testing.T) {
	dir := t.TempDir()
	cfg := testGvproxyConfig()
	cfg.cloudInventoryDirectory = dir
	var err error
	cfg.guard, err = compilePlatformGuard(nil, true, cfg.Subnet)
	if err != nil {
		t.Fatal(err)
	}
	assertRefused := func() {
		t.Helper()
		vn, policy, err := newGvproxyNetwork(t.Context(), buildTapConfig(cfg, types.QemuProtocol),
			cfg, nil, nil, outboundPolicy{Mode: "enabled"})
		if err == nil || vn != nil || policy != nil {
			t.Fatalf("invalid authority constructed a network: error=%v", err)
		}
	}
	assertRefused()
	doc := testCloudInventory([]string{"127.0.0.1:1"})
	doc.ExpiresAt = time.Now().Add(-time.Second)
	writeCloudInventory(t, dir, doc)
	assertRefused()

	doc.ExpiresAt = time.Now().Add(time.Hour)
	other := t.TempDir()
	writeCloudInventory(t, other, doc)
	path := filepath.Join(dir, guardinventory.FileName)
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(other, guardinventory.FileName), path); err != nil {
		t.Fatal(err)
	}
	assertRefused()
}

func TestCloudStartupRequiresMatchedAuthorityInBothFormats(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("Cloud startup requires Linux")
	}
	for _, format := range []string{"flat", "complete"} {
		for _, scenario := range []struct {
			name, rejected string
		}{
			{name: "active"},
			{name: "unavailable service", rejected: "connect to Cloud guard service"},
			{name: "wrong revision", rejected: "confirmation does not match"},
			{name: "wrong digest", rejected: "confirmation does not match"},
			{name: "expired proof", rejected: "confirmation does not match"},
			{name: "missing resolvers", rejected: "resolver"},
		} {
			t.Run(format+"/"+scenario.name, func(t *testing.T) {
				directory := t.TempDir()
				document := testCloudInventory([]string{"192.0.2.53:53"})
				writeCloudInventory(t, directory, document)
				inventory, err := guardinventory.Sample(t.Context(), directory)
				if err != nil {
					t.Fatal(err)
				}
				config := testGvproxyConfig()
				config.CloudGuard = &cloudBootstrap{
					InventoryDirectory: directory, ShimSocket: filepath.Join(directory, "g.sock"),
					Box: "test-box", Instance: "test-instance", Revision: inventory.Revision,
					Digest: hex.EncodeToString(inventory.Digest[:]),
				}
				switch scenario.name {
				case "unavailable service":
				case "missing resolvers":
					document.ResolverEndpoints = nil
					writeCloudInventory(t, directory, document)
				default:
					revision, digest := inventory.Revision, config.CloudGuard.Digest
					if scenario.name == "wrong revision" {
						revision = "stale"
					} else if scenario.name == "wrong digest" {
						digest = strings.Repeat("0", 64)
					}
					deadline := uint64(1 << 63)
					if scenario.name == "expired proof" {
						deadline = 1
					}
					listenCloudStartupProof(t, config.CloudGuard.ShimSocket, revision, digest, deadline)
				}
				var wire any = config
				if format == "complete" {
					wire = map[string]any{
						"config": config,
						"outbound_v1": completeOutboundStartup{Snapshot: completeOutboundSnapshot{
							Policy:   completeOutboundPolicy{Mode: "enabled", AllowNet: []string{}, DenyNet: []string{}},
							Revision: "initial", Admission: legacyAdmission,
						}},
					}
				}
				raw, err := json.Marshal(wire)
				if err != nil {
					t.Fatal(err)
				}
				config, initial, err := decodeGvproxyStartup(raw)
				if err != nil {
					t.Fatal(err)
				}
				ctx, cancel := context.WithCancel(t.Context())
				defer cancel()
				vn, policy, err := newGvproxyNetwork(ctx, buildTapConfig(config, types.QemuProtocol), config, nil, nil, initial)
				if scenario.rejected != "" {
					if err == nil || !strings.Contains(err.Error(), scenario.rejected) || vn != nil || policy != nil {
						t.Fatalf("unexpected Cloud startup result: net=%v, policy=%v, error=%v", vn != nil, policy != nil, err)
					}
					return
				}
				if err != nil || vn == nil || policy == nil || !policy.guard.active() {
					t.Fatalf("matched Cloud startup did not activate the guard: %v", err)
				}
				defer policy.stack.Close()
			})
		}
	}
}

func listenCloudStartupProof(t *testing.T, path, revision, digest string, deadline uint64) {
	t.Helper()
	listener, err := net.ListenUnix("unixpacket", &net.UnixAddr{Name: path, Net: "unixpacket"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		connection, err := listener.AcceptUnix()
		if err != nil {
			return
		}
		defer connection.Close()
		_ = connection.SetDeadline(time.Now().Add(time.Second))
		request := make([]byte, 4096)
		count, err := connection.Read(request)
		var message struct{ Operation, Box, Instance string }
		if err == nil && json.Unmarshal(request[:count], &message) == nil &&
			message.Operation == "check" && message.Box == "test-box" && message.Instance == "test-instance" {
			_ = json.NewEncoder(connection).Encode(map[string]any{
				"instance": message.Instance, "revision": revision, "digest": digest, "cgroup_id": 1, "deadline_ns": deadline,
			})
		}
	}()
}

func TestCloudInventorySuspendsEstablishedGuestNetworking(t *testing.T) {
	for _, tc := range []string{"changed digest", "missing file", "absolute expiry"} {
		t.Run(tc, func(t *testing.T) {
			cfg := udpServiceConfig()
			cfg.cloudInventoryDirectory = t.TempDir()
			doc := testCloudInventory([]string{"127.0.0.1:1"})
			if tc == "absolute expiry" {
				doc.ExpiresAt = time.Now().Add(750 * time.Millisecond)
			}
			writeCloudInventory(t, cfg.cloudInventoryDirectory, doc)
			target, port := newUDPTestTarget(t)
			const public = "203.0.113.91"
			tap := startNetworkWithSeams(t, cfg, networkSeams{
				cloud: true, nat: map[string]string{unlistedIP: public}, dial: target.dial,
			})
			epoch := tap.policy.guard.epoch
			requireUDPServiceReplies(t, tap, cfg)
			tap.send(t, udpFrame(t, unlistedIP, port, []byte("before retirement")))
			target.echo(t, tap, unlistedIP, guestSrcPort, port, "before retirement")
			target.requireDial(t, public, port)
			if tc != "absolute expiry" {
				epoch.mu.Lock()
				initial := epoch.until
				epoch.mu.Unlock()
				waitUDPCondition(t, "an unchanged inventory to renew the live lease", func() bool {
					epoch.mu.Lock()
					defer epoch.mu.Unlock()
					return epoch.until.After(initial)
				})
			}
			switch tc {
			case "changed digest":
				// The revision stays the same. The file content determines identity.
				doc.ProtectedNetworks.Node = []string{public + "/32"}
				writeCloudInventory(t, cfg.cloudInventoryDirectory, doc)
			case "missing file":
				if err := os.Remove(filepath.Join(cfg.cloudInventoryDirectory, guardinventory.FileName)); err != nil {
					t.Fatal(err)
				}
			}
			waitForCloudRetirement(t, epoch)
			waitUDPCondition(t, "the established UDP socket to release its slot", func() bool {
				return len(tap.policy.udpFlows.slots) == 0
			})
			if tap.policy.guard.active() || target.dials.Load() != 1 {
				t.Fatalf("retired inventory remained active or redialed the host")
			}
			response := httptest.NewRecorder()
			epoch.status(tap.policy.inventory)(response, httptest.NewRequest(http.MethodGet, platformGuardStatus, nil))
			if response.Code != http.StatusServiceUnavailable {
				t.Fatalf("retired epoch status = %d", response.Code)
			}
		})
	}
}

func TestCloudInventoryClosesTCPAndCancelsPendingSetup(t *testing.T) {
	cfg := testGvproxyConfig()
	cfg.cloudInventoryDirectory = t.TempDir()
	doc := testCloudInventory([]string{"127.0.0.1:1"})
	writeCloudInventory(t, cfg.cloudInventoryDirectory, doc)
	listener, port := listenTCP(t)
	pending, canceled := make(chan struct{}), make(chan error, 1)
	tap := startNetworkWithSeams(t, cfg, networkSeams{
		cloud: true, nat: map[string]string{unlistedIP: "203.0.113.90"},
		connect: func(ctx context.Context, target egressTarget) (net.Conn, error) {
			if target.Port == port {
				return (&net.Dialer{}).DialContext(ctx, "tcp4", listener.Addr().String())
			}
			close(pending)
			<-ctx.Done()
			canceled <- ctx.Err()
			return nil, ctx.Err()
		},
	})
	dial := startGuestStack(t, tap, cfg)
	active, err := dial(unlistedIP, port)
	if err != nil {
		t.Fatal(err)
	}
	defer active.Close()
	if err := listener.(*net.TCPListener).SetDeadline(time.Now().Add(forwardWindow)); err != nil {
		t.Fatal(err)
	}
	host, err := listener.Accept()
	if err != nil {
		t.Fatal(err)
	}
	defer host.Close()
	if _, err := active.Write([]byte("before retirement")); err != nil {
		t.Fatal(err)
	}
	_ = host.SetReadDeadline(time.Now().Add(forwardWindow))
	buf := make([]byte, len("before retirement"))
	if _, err := io.ReadFull(host, buf); err != nil || string(buf) != "before retirement" {
		t.Fatalf("host received %q: %v", buf, err)
	}
	go func() {
		if conn, err := dial(unlistedIP, port^0x8000); err == nil {
			_ = conn.Close()
		}
	}()
	select {
	case <-pending:
	case <-time.After(forwardWindow):
		t.Fatal("second guest TCP flow did not enter setup")
	}
	doc.Revision = "inventory-2"
	writeCloudInventory(t, cfg.cloudInventoryDirectory, doc)
	waitForCloudRetirement(t, tap.policy.guard.epoch)
	select {
	case err := <-canceled:
		if err != context.Canceled {
			t.Fatalf("pending setup ended with %v", err)
		}
	case <-time.After(forwardWindow):
		t.Fatal("retirement left the TCP dial pending")
	}
	_ = host.SetReadDeadline(time.Now().Add(forwardWindow))
	if _, err := host.Read(buf); err != io.EOF {
		t.Fatalf("established host TCP socket stayed open: %v", err)
	}
}

func waitForCloudRetirement(t *testing.T, epoch *cloudGuardEpoch) {
	t.Helper()
	select {
	case <-epoch.ctx.Done():
	case <-time.After(forwardWindow):
		t.Fatal("Cloud inventory did not retire")
	}
}
