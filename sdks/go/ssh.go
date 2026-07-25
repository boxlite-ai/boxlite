//go:build unix

package boxlite

/*
#include "bridge.h"
*/
import "C"
import (
	"context"
	"time"
	"unsafe"
)

// SshIdentityStatus reports the guest-observed SSH host identity health.
type SshIdentityStatus int

const (
	SshIdentityUnknown SshIdentityStatus = iota
	SshIdentityReady
	SshIdentityDegraded
)

// SshAccessEntry is one box-scoped temporary SSH credential to authorize.
type SshAccessEntry struct {
	CredentialID string
	GrantID      string
	// PublicKey is a canonical OpenSSH public-key line.
	PublicKey   string
	Fingerprint string
	// UnixUser is fixed to "root" in this design.
	UnixUser  string
	ExpiresAt time.Time
}

// SshStatus is the applied generation, listener readiness, and host
// identity, as last observed from the guest.
type SshStatus struct {
	AppliedGeneration uint64
	ListenerReady     bool
	// HostPublicKey is the OpenSSH-format host public key.
	HostPublicKey   string
	HostFingerprint string
	IdentityStatus  SshIdentityStatus
}

// Ssh is a box-scoped handle for the SSH access-set control facade.
//
// Internal control plane only: apply/query which temporary SSH credentials
// the guest's russh listener currently authenticates. SSH bytes themselves
// still flow over Box.Network().Tunnel(); this handle never touches them.
type Ssh struct {
	handle *C.CBoxSshHandle
}

// SSH returns the box-scoped handle for the SSH access-set control facade.
func (b *Box) SSH() (*Ssh, error) {
	if b == nil || b.handle == nil {
		return nil, ErrRuntimeClosed
	}

	var cSsh *C.CBoxSshHandle
	var cerr C.CBoxliteError
	code := C.boxlite_box_ssh(b.handle, &cSsh, &cerr)
	if code != C.Ok {
		return nil, freeError(&cerr)
	}

	return &Ssh{handle: cSsh}, nil
}

// Close releases the SSH handle.
func (s *Ssh) Close() error {
	if s != nil && s.handle != nil {
		C.boxlite_ssh_free(s.handle)
		s.handle = nil
	}
	return nil
}

// ReplaceAccessSet performs a full-set replace of the guest's active SSH
// access snapshot. `generation` must be strictly newer than the guest's
// currently applied generation, or identical with byte-identical accesses
// (idempotent retry) -- anything older or conflicting returns an error and
// leaves the guest's snapshot unchanged.
func (s *Ssh) ReplaceAccessSet(ctx context.Context, generation uint64, accesses []SshAccessEntry) (*SshStatus, error) {
	if s == nil || s.handle == nil {
		return nil, ErrRuntimeClosed
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	cEntries := make([]C.CBoxliteSshAccessEntry, len(accesses))
	var cStrings []*C.char
	defer func() {
		for _, p := range cStrings {
			C.free(unsafe.Pointer(p))
		}
	}()
	for i, e := range accesses {
		credentialID := C.CString(e.CredentialID)
		grantID := C.CString(e.GrantID)
		publicKey := C.CString(e.PublicKey)
		fingerprint := C.CString(e.Fingerprint)
		unixUser := C.CString(e.UnixUser)
		cStrings = append(cStrings, credentialID, grantID, publicKey, fingerprint, unixUser)
		cEntries[i] = C.CBoxliteSshAccessEntry{
			credential_id:           credentialID,
			grant_id:                grantID,
			public_key:              publicKey,
			fingerprint:             fingerprint,
			unix_user:               unixUser,
			expires_at_unix_seconds: C.int64_t(e.ExpiresAt.Unix()),
		}
	}

	var accessesPtr *C.CBoxliteSshAccessEntry
	if len(cEntries) > 0 {
		accessesPtr = &cEntries[0]
	}

	var cStatus *C.CBoxliteSshStatus
	var cerr C.CBoxliteError
	code := C.boxlite_ssh_replace_access_set(
		s.handle,
		C.uint64_t(generation),
		accessesPtr,
		C.size_t(len(cEntries)),
		&cStatus,
		&cerr,
	)
	if code != C.Ok {
		return nil, freeError(&cerr)
	}
	defer C.boxlite_ssh_status_free(cStatus)
	return sshStatusFromC(cStatus), nil
}

// Status queries applied generation, listener readiness, and host identity.
func (s *Ssh) Status(ctx context.Context) (*SshStatus, error) {
	if s == nil || s.handle == nil {
		return nil, ErrRuntimeClosed
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	var cStatus *C.CBoxliteSshStatus
	var cerr C.CBoxliteError
	code := C.boxlite_ssh_status(s.handle, &cStatus, &cerr)
	if code != C.Ok {
		return nil, freeError(&cerr)
	}
	defer C.boxlite_ssh_status_free(cStatus)
	return sshStatusFromC(cStatus), nil
}

func sshStatusFromC(cStatus *C.CBoxliteSshStatus) *SshStatus {
	status := &SshStatus{
		AppliedGeneration: uint64(cStatus.applied_generation),
		ListenerReady:     bool(cStatus.listener_ready),
		HostPublicKey:     C.GoString(cStatus.host_public_key),
		HostFingerprint:   C.GoString(cStatus.host_fingerprint),
	}
	switch cStatus.identity_status {
	case C.Ready:
		status.IdentityStatus = SshIdentityReady
	case C.Degraded:
		status.IdentityStatus = SshIdentityDegraded
	default:
		status.IdentityStatus = SshIdentityUnknown
	}
	return status
}
