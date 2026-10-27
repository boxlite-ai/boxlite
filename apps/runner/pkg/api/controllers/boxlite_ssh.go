package controllers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"slices"

	sdkboxlite "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/boxlite"
	"github.com/boxlite-ai/runner/pkg/runner"
	"github.com/gin-gonic/gin"
)

// errInvalidSSHConfig is the whole answer to a rejected body, as on `boxlite
// serve`: a decoder's own message can quote the input, which holds a private key.
var errInvalidSSHConfig = errors.New("invalid SSH configuration")

const maxSSHConfigBytes = 64 << 10

// sshStatusResponse is the SshStatus schema; every field is always present.
type sshStatusResponse struct {
	Enabled            bool   `json:"enabled"`
	Generation         uint64 `json:"generation"`
	ListenAddress      string `json:"listen_address"`
	HostPublicKey      string `json:"host_public_key"`
	HostKeyFingerprint string `json:"host_key_fingerprint"`
}

// BoxliteSSHConfigure replaces a running box's guest SSH configuration. The
// guest restarts its listener on every accepted call, so it runs exactly once.
func BoxliteSSHConfigure(ctx *gin.Context) {
	config, err := parseSSHConfig(http.MaxBytesReader(ctx.Writer, ctx.Request.Body, maxSSHConfigBytes))
	if err != nil {
		respondError(ctx, http.StatusBadRequest, errInvalidSSHConfig.Error(), "InvalidArgumentError", "invalid_argument")
		return
	}
	runSSH(ctx, func(client *boxlite.Client, rctx context.Context, boxID string) (*sdkboxlite.SSHStatus, error) {
		return client.SSHConfigure(rctx, boxID, config)
	})
}

// BoxliteSSHStatus reports the guest SSH listener without starting the box.
func BoxliteSSHStatus(ctx *gin.Context) { runSSH(ctx, (*boxlite.Client).SSHStatus) }

// BoxliteSSHDisable stops the guest SSH listener without starting the box.
func BoxliteSSHDisable(ctx *gin.Context) { runSSH(ctx, (*boxlite.Client).SSHDisable) }

func runSSH(ctx *gin.Context, call func(*boxlite.Client, context.Context, string) (*sdkboxlite.SSHStatus, error)) {
	r, err := runner.GetInstance(nil)
	if err != nil {
		respondError(ctx, http.StatusInternalServerError, "runner unavailable", "InternalError", "internal_error")
		return
	}
	status, err := call(r.Boxlite, ctx.Request.Context(), ctx.Param("boxId"))
	respondSSH(ctx, status, err)
}

func respondSSH(ctx *gin.Context, status *sdkboxlite.SSHStatus, err error) {
	if errors.Is(err, boxlite.ErrBoxNotRunning) {
		respondError(ctx, http.StatusConflict, err.Error(), "InvalidStateError", "invalid_state")
		return
	}
	if err != nil {
		respondCopyError(ctx, err)
		return
	}
	ctx.JSON(http.StatusOK, sshStatusResponse{
		Enabled:            status.Enabled,
		Generation:         status.Generation,
		ListenAddress:      status.ListenAddress,
		HostPublicKey:      status.HostPublicKey,
		HostKeyFingerprint: status.HostKeyFingerprint,
	})
}

// parseSSHConfig reads exactly one SshConfig object. It walks each object by
// member name instead of decoding into structs: encoding/json matches keys
// case-insensitively and lets a repeated key win, where serde (and so `boxlite
// serve`) rejects both.
func parseSSHConfig(body io.Reader) (sdkboxlite.SSHConfig, error) {
	var config sdkboxlite.SSHConfig
	decoder := json.NewDecoder(body)
	var raw json.RawMessage
	if err := decoder.Decode(&raw); err != nil {
		return config, errInvalidSSHConfig
	}
	if err := decoder.Decode(new(json.RawMessage)); err != io.EOF {
		return config, errInvalidSSHConfig
	}
	members, err := jsonMembers(raw, []string{"listen_address", "host_private_key", "accounts"})
	if err != nil {
		return config, err
	}
	if config.ListenAddress, err = jsonValue[string](members["listen_address"]); err != nil {
		return config, err
	}
	if config.HostPrivateKey, err = jsonValue[string](members["host_private_key"]); err != nil {
		return config, err
	}
	accounts, err := jsonValue[[]json.RawMessage](members["accounts"])
	if err != nil {
		return config, err
	}
	for _, rawAccount := range accounts {
		account, err := parseSSHAccount(rawAccount)
		if err != nil {
			return config, err
		}
		config.Accounts = append(config.Accounts, account)
	}
	return config, nil
}

// parseSSHAccount reads one SshAccount: `authorized_keys` may be absent but
// not null, and `ca` may be null.
func parseSSHAccount(raw json.RawMessage) (sdkboxlite.SSHAccount, error) {
	var account sdkboxlite.SSHAccount
	members, err := jsonMembers(raw, []string{"login"}, "authorized_keys", "ca")
	if err != nil {
		return account, err
	}
	if account.Login, err = jsonValue[string](members["login"]); err != nil {
		return account, err
	}
	if rawKeys, ok := members["authorized_keys"]; ok {
		keys, err := jsonValue[[]json.RawMessage](rawKeys)
		if err != nil {
			return account, err
		}
		for _, rawKey := range keys {
			key, err := jsonValue[string](rawKey)
			if err != nil {
				return account, err
			}
			account.AuthorizedKeys = append(account.AuthorizedKeys, key)
		}
	}
	if rawCA, ok := members["ca"]; ok && !bytes.Equal(rawCA, []byte("null")) {
		ca, err := jsonMembers(rawCA, []string{"public_key", "principal"})
		if err != nil {
			return account, err
		}
		account.CA = &sdkboxlite.SSHCAConfig{}
		if account.CA.PublicKey, err = jsonValue[string](ca["public_key"]); err != nil {
			return account, err
		}
		if account.CA.Principal, err = jsonValue[string](ca["principal"]); err != nil {
			return account, err
		}
	}
	return account, nil
}

// jsonMembers splits a JSON object into its members, refusing a non-object, a
// member not named exactly, a repeated member, and a missing required one.
func jsonMembers(raw json.RawMessage, required []string, optional ...string) (map[string]json.RawMessage, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
		return nil, errInvalidSSHConfig
	}
	members := make(map[string]json.RawMessage)
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return nil, errInvalidSSHConfig
		}
		name, _ := token.(string)
		if _, repeated := members[name]; repeated ||
			(!slices.Contains(required, name) && !slices.Contains(optional, name)) {
			return nil, errInvalidSSHConfig
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, errInvalidSSHConfig
		}
		members[name] = value
	}
	for _, name := range required {
		if _, ok := members[name]; !ok {
			return nil, errInvalidSSHConfig
		}
	}
	return members, nil
}

// jsonValue decodes a required value, rejecting null rather than treating it as empty.
func jsonValue[T any](raw json.RawMessage) (value T, err error) {
	var decoded *T
	if json.Unmarshal(raw, &decoded) != nil || decoded == nil {
		return value, errInvalidSSHConfig
	}
	return *decoded, nil
}
