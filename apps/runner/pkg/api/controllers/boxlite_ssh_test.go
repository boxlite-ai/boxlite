package controllers

import (
	"context"
	"encoding/json"
	sdk "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/gin-gonic/gin"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSSHInvalidConfigurationIsSanitized(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.POST("/v1/boxes/:boxId/ssh/configure", BoxliteSshConfigure)
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/v1/boxes/alias/ssh/configure", strings.NewReader(`{"host_private_key":"sentinel-private","accounts":"sentinel-secret"}`))
	request.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d: %s", response.Code, response.Body.String())
	}
	if strings.Contains(response.Body.String(), "sentinel") {
		t.Fatal("credentials echoed")
	}
	if !strings.Contains(response.Body.String(), "invalid_argument") {
		t.Fatal("missing error code")
	}
}

type fakeSSH struct {
	config    sdk.SSHConfig
	operation string
	closed    int
	err       error
}

func (s *fakeSSH) Status(context.Context) (*sdk.SSHStatus, error) {
	s.operation = "status"
	return &sdk.SSHStatus{Enabled: true, Generation: ^uint64(0), ListenAddress: "addr", HostPublicKey: "key", HostKeyFingerprint: "fp"}, s.err
}
func (s *fakeSSH) Disable(ctx context.Context) (*sdk.SSHStatus, error) {
	status, err := s.Status(ctx)
	s.operation = "disable"
	status.Enabled = false
	return status, err
}
func (s *fakeSSH) Configure(ctx context.Context, config sdk.SSHConfig) (*sdk.SSHStatus, error) {
	status, err := s.Status(ctx)
	s.operation = "configure"
	s.config = config
	return status, err
}
func (s *fakeSSH) Close() error { s.closed++; return nil }

func TestSSHControllerOperations(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, operation := range []string{"status", "disable", "configure"} {
		for _, failure := range []string{"", "acquire", "operation"} {
			t.Run(operation+"/"+failure, func(t *testing.T) {
				ssh := &fakeSSH{}
				controller := sshController{acquire: func(ctx *gin.Context) (sshOperations, error) {
					if ctx.Param("boxId") != "alias" {
						t.Fatal("box ID lost")
					}
					if failure == "acquire" {
						return nil, &sdk.Error{Code: sdk.ErrNotFound, Message: "box missing"}
					}
					if failure == "operation" {
						ssh.err = &sdk.Error{Code: sdk.ErrInvalidArgument, Message: "invalid SSH configuration"}
					}
					return ssh, nil
				}}
				router := gin.New()
				router.POST("/boxes/:boxId/ssh", map[string]gin.HandlerFunc{"status": controller.status, "disable": controller.disable, "configure": controller.configure}[operation])
				request := httptest.NewRequest(http.MethodPost, "/boxes/alias/ssh", strings.NewReader(`{"listen_address":"addr","host_private_key":"sentinel-private","accounts":[{"login":"alice","authorized_keys":["sentinel-key"],"ca":{"public_key":"sentinel-ca","principal":"alice"}}]}`))
				request.Header.Set("Content-Type", "application/json")
				response := httptest.NewRecorder()
				router.ServeHTTP(response, request)
				wantStatus, wantClosed := http.StatusOK, 1
				if failure == "acquire" {
					wantStatus, wantClosed = http.StatusNotFound, 0
				}
				if failure == "operation" {
					wantStatus = http.StatusBadRequest
				}
				if response.Code != wantStatus || ssh.closed != wantClosed {
					t.Fatalf("response=%d %s closes=%d", response.Code, response.Body, ssh.closed)
				}
				if strings.Contains(response.Body.String(), "sentinel") {
					t.Fatal("credentials echoed")
				}
				if failure != "acquire" && ssh.operation != operation {
					t.Fatalf("operation=%s", ssh.operation)
				}
				if operation == "configure" && failure != "acquire" {
					if ssh.config.HostPrivateKey != "sentinel-private" || ssh.config.Accounts[0].CA.PublicKey != "sentinel-ca" || ssh.config.Accounts[0].AuthorizedKeys[0] != "sentinel-key" {
						t.Fatal("configuration lost")
					}
				}
				if failure == "" {
					var status sdk.SSHStatus
					if err := json.Unmarshal(response.Body.Bytes(), &status); err != nil {
						t.Fatal(err)
					}
					if status.Generation != ^uint64(0) || status.HostPublicKey != "key" || status.HostKeyFingerprint != "fp" || status.ListenAddress != "addr" || status.Enabled != (operation != "disable") {
						t.Fatalf("status=%+v", status)
					}
				}
			})
		}
	}
}
