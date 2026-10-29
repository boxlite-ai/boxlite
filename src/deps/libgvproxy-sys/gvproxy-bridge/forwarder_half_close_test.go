package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/adapters/gonet"
	"gvisor.dev/gvisor/pkg/tcpip/network/ipv4"
	"gvisor.dev/gvisor/pkg/tcpip/stack"
)

func TestEgressPreservesHalfClose(t *testing.T) {
	for _, reverse := range []bool{false, true} {
		t.Run(fmt.Sprintf("upstream_first=%v", reverse), func(t *testing.T) {
			for _, route := range []string{"unrestricted_upstream", "allow_ip_standard", "allow_hostname_inspected"} {
				t.Run(route, func(t *testing.T) {
					listener, err := net.ListenTCP("tcp", &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)})
					if err != nil {
						t.Fatal(err)
					}
					defer listener.Close()
					listener.SetDeadline(time.Now().Add(5 * time.Second))
					const request = "GET / HTTP/1.0\r\nHost: half-close.example.test\r\n\r\n"
					const reply = "response after EOF"
					upstreamDone := make(chan error, 1)
					go func() {
						conn, err := listener.AcceptTCP()
						if err != nil {
							upstreamDone <- err
							return
						}
						defer conn.Close()
						conn.SetDeadline(time.Now().Add(5 * time.Second))
						var body []byte
						if reverse {
							body = make([]byte, len(request))
							_, err = io.ReadFull(conn, body)
						} else {
							body, err = io.ReadAll(conn)
						}
						if err != nil || string(body) != request {
							upstreamDone <- fmt.Errorf("upstream request = %q, error = %v", body, err)
							return
						}
						_, err = io.WriteString(conn, reply)
						if err == nil {
							err = conn.CloseWrite()
						}
						if reverse && err == nil {
							body, err = io.ReadAll(conn)
							if err == nil && string(body) != "after upstream EOF" {
								err = fmt.Errorf("payload after upstream EOF = %q", body)
							}
						}
						upstreamDone <- err
					}()

					cfg := testGvproxyConfig()
					port := uint16(listener.Addr().(*net.TCPAddr).Port)
					seams := networkSeams{}
					switch route {
					case "allow_ip_standard":
						cfg.AllowNet = []string{coveringCIDR}
					case "allow_hostname_inspected":
						cfg.AllowNet = []string{"half-close.example.test"}
						port = 80
						seams.resolve = func(context.Context, string) ([]net.IP, error) {
							return []net.IP{net.ParseIP("198.51.100.1")}, nil
						}
						seams.dial = func(ctx context.Context, network, addr string) (net.Conn, error) {
							if addr != "198.51.100.1:80" {
								return nil, fmt.Errorf("unexpected upstream address %q", addr)
							}
							return (&net.Dialer{}).DialContext(ctx, "tcp", listener.Addr().String())
						}
					}
					tap := startNetworkWithSeams(t, cfg, seams)
					dial := startGuestStack(t, tap, cfg)
					guest, err := dial(unlistedIP, port)
					if err != nil {
						t.Fatal(err)
					}
					defer guest.Close()
					guest.SetDeadline(time.Now().Add(5 * time.Second))
					if _, err := io.WriteString(guest, request); err != nil {
						t.Fatal(err)
					}
					if !reverse {
						if err := guest.(interface{ CloseWrite() error }).CloseWrite(); err != nil {
							t.Fatal(err)
						}
					}
					body, readErr := io.ReadAll(guest)
					if reverse {
						if _, err := io.WriteString(guest, "after upstream EOF"); err != nil {
							t.Fatal(err)
						}
						if err := guest.(interface{ CloseWrite() error }).CloseWrite(); err != nil {
							t.Fatal(err)
						}
					}
					select {
					case err := <-upstreamDone:
						if err != nil {
							t.Errorf("upstream exchange failed: %v", err)
						}
					case <-time.After(6 * time.Second):
						t.Fatal("upstream exchange did not finish")
					}
					if readErr != nil || string(body) != reply {
						t.Fatalf("guest response after half-close = %q, error = %v; want %q", body, readErr, reply)
					}
				})
			}
		})
	}
}

func TestPortMappingPreservesHalfClose(t *testing.T) {
	for _, reverse := range []bool{false, true} {
		t.Run(fmt.Sprintf("guest_first=%v", reverse), func(t *testing.T) {
			for _, protocol := range []string{"tcp", "unix"} {
				t.Run(protocol, func(t *testing.T) {
					cfg := testGvproxyConfig()
					tap := startNetworkWith(t, cfg)
					vn := tap.policy.vn
					var target net.Listener
					// Attach a listening guest stack across the actual virtual link.
					startGuestStack(t, tap, cfg, func(s *stack.Stack) {
						var err error
						target, err = gonet.ListenTCP(s, tcpip.FullAddress{
							NIC: 1, Addr: tcpip.AddrFromSlice(net.ParseIP(cfg.GuestIP).To4()), Port: 18081,
						}, ipv4.ProtocolNumber)
						if err != nil {
							t.Fatal(err)
						}
					})
					defer target.Close()
					socketDir, err := os.MkdirTemp("/tmp", "hc-audit-")
					if err != nil {
						t.Fatal(err)
					}
					t.Cleanup(func() { os.RemoveAll(socketDir) })
					local := socketDir + "/forward.sock"
					remote := "tcp://" + cfg.GuestIP + ":18081"
					if protocol == "tcp" {
						reservation, err := net.Listen("tcp", "127.0.0.1:0")
						if err != nil {
							t.Fatal(err)
						}
						local = reservation.Addr().String()
						reservation.Close()
						remote = cfg.GuestIP + ":18081"
					}
					body, err := json.Marshal(map[string]string{"local": local, "remote": remote, "protocol": protocol})
					if err != nil {
						t.Fatal(err)
					}
					handler := controlMux(vn.ServicesMux(), vn.DialContextTCP)
					recorder := httptest.NewRecorder()
					handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/services/forwarder/expose", bytes.NewReader(body)))
					if recorder.Code != http.StatusOK {
						t.Fatalf("expose status = %d, body = %s", recorder.Code, recorder.Body.String())
					}
					defer handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/services/forwarder/unexpose", bytes.NewReader(body)))
					const request = "request"
					const reply = "response after EOF"
					targetDone := make(chan error, 1)
					go func() {
						peer, err := target.Accept()
						if err != nil {
							targetDone <- err
							return
						}
						defer peer.Close()
						peer.SetDeadline(time.Now().Add(5 * time.Second))
						var got []byte
						if reverse {
							got = make([]byte, len(request))
							_, err = io.ReadFull(peer, got)
						} else {
							got, err = io.ReadAll(peer)
						}
						if err != nil || string(got) != request {
							targetDone <- fmt.Errorf("target request = %q, error = %v", got, err)
							return
						}
						_, err = io.WriteString(peer, reply)
						if err == nil {
							err = peer.(interface{ CloseWrite() error }).CloseWrite()
						}
						if reverse && err == nil {
							got, err = io.ReadAll(peer)
							if err == nil && string(got) != "after guest EOF" {
								err = fmt.Errorf("payload after guest EOF = %q", got)
							}
						}
						targetDone <- err
					}()
					client, err := net.DialTimeout(protocol, local, 5*time.Second)
					if err != nil {
						t.Fatal(err)
					}
					defer client.Close()
					client.SetDeadline(time.Now().Add(5 * time.Second))
					if _, err := io.WriteString(client, request); err != nil {
						t.Fatal(err)
					}
					if !reverse {
						if err := client.(interface{ CloseWrite() error }).CloseWrite(); err != nil {
							t.Fatal(err)
						}
					}
					got, readErr := io.ReadAll(client)
					if reverse {
						if _, err := io.WriteString(client, "after guest EOF"); err != nil {
							t.Fatal(err)
						}
						if err := client.(interface{ CloseWrite() error }).CloseWrite(); err != nil {
							t.Fatal(err)
						}
					}
					select {
					case err := <-targetDone:
						if err != nil {
							t.Errorf("target exchange failed: %v", err)
						}
					case <-time.After(6 * time.Second):
						t.Fatal("target exchange did not finish")
					}
					if readErr != nil || string(got) != reply {
						t.Fatalf("mapped response after half-close = %q, error = %v; want %q", got, readErr, reply)
					}
				})
			}
		})
	}
}
