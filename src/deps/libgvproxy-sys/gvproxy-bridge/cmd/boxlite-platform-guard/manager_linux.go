//go:build linux

package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sync"
	"time"

	"github.com/boxlite/gvproxy-bridge/internal/guardinventory"
	"github.com/boxlite/gvproxy-bridge/internal/guardkernel"
)

var component = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,128}$`)

type record struct {
	Box            string            `json:"box"`
	Instance       string            `json:"instance"`
	DataSocket     string            `json:"data_socket"`
	Revision       string            `json:"revision"`
	Digest         [32]byte          `json:"digest"`
	HostAddresses  []string          `json:"host_addresses"`
	AbsoluteCutoff uint64            `json:"absolute_cutoff"`
	Kernel         guardkernel.Proof `json:"kernel"`
	ShimPID        int32             `json:"shim_pid,omitempty"`
	ShimStart      uint64            `json:"shim_start,omitempty"`
}

type manager struct {
	object, pins, cgroups, records, inventory string
	mu                                        sync.Mutex
	active                                    map[string]record
	retired                                   map[string]struct{}
	preparing                                 map[string]struct{}
	sampler                                   guardinventory.Sampler
}

func (m *manager) pinDir(box string) string {
	return filepath.Join(m.pins, box)
}

func (m *manager) cgroup(box string) string {
	return filepath.Join(m.cgroups, box)
}

func (m *manager) recordPath(box string) string {
	return filepath.Join(m.records, box+".json")
}

func (m *manager) checkReadiness(ctx context.Context) (err error) {
	if _, err := m.sampler.Sample(ctx, m.inventory); err != nil {
		return err
	}
	if err := os.MkdirAll(m.cgroups, 0o755); err != nil {
		return err
	}
	group, err := os.MkdirTemp(m.cgroups, "guard_probe_")
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, os.Remove(group)) }()
	pin := m.pinDir(filepath.Base(group))
	if _, err := guardkernel.Attach(m.object, pin, group); err != nil {
		return err
	}
	defer func() { err = errors.Join(err, guardkernel.Remove(pin, group)) }()
	accepted, err := guardkernel.RenewDeadline(pin, 0, 0)
	if err != nil {
		return err
	}
	if accepted {
		return fmt.Errorf("Cloud guard renewal accepted an unopened lease")
	}
	return nil
}

func (m *manager) recover() error {
	entries, err := os.ReadDir(m.records)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(m.records, entry.Name()))
		if err != nil {
			return err
		}
		var stored record
		if err := json.Unmarshal(raw, &stored); err != nil || !component.MatchString(stored.Box) ||
			entry.Name() != stored.Box+".json" || !component.MatchString(stored.Instance) {
			return fmt.Errorf("invalid persisted Cloud guard record")
		}
		if _, err := m.prove(stored); err != nil {
			m.retired[stored.Box] = struct{}{}
			continue
		}
		m.active[stored.Box] = stored
	}
	return nil
}

func (m *manager) prepare(ctx context.Context, box, instance, dataSocket string) (next record, err error) {
	if !component.MatchString(box) || !component.MatchString(instance) ||
		!filepath.IsAbs(dataSocket) || filepath.Clean(dataSocket) != dataSocket {
		return record{}, fmt.Errorf("invalid Cloud guard launch identity")
	}
	m.mu.Lock()
	if _, preparing := m.preparing[box]; preparing {
		m.mu.Unlock()
		return record{}, fmt.Errorf("Cloud guard is preparing this Box")
	}
	if prior, ok := m.active[box]; ok {
		if _, err := m.prove(prior); err == nil {
			m.mu.Unlock()
			if prior.ShimPID == 0 && prior.Instance == instance && prior.DataSocket == dataSocket {
				return prior, nil
			}
			return record{}, fmt.Errorf("Cloud guard has a current Box instance")
		}
	}
	m.preparing[box] = struct{}{}
	delete(m.active, box)
	delete(m.retired, box)
	m.mu.Unlock()

	// Loading BPF and publishing the record may block. Other Boxes keep
	// renewing while this Box owns its launch reservation.
	defer func() {
		m.mu.Lock()
		defer m.mu.Unlock()
		delete(m.preparing, box)
		if err != nil {
			m.retired[box] = struct{}{}
		} else {
			m.active[box] = next
		}
	}()
	return m.install(ctx, box, instance, dataSocket)
}

func (m *manager) install(ctx context.Context, box, instance, dataSocket string) (record, error) {
	pin, group := m.pinDir(box), m.cgroup(box)
	// The kernel verifies that an earlier instance has exited before its
	// pins can be removed or a new guard installed.
	if err := guardkernel.Remove(pin, group); err != nil {
		return record{}, err
	}
	if err := os.Remove(m.recordPath(box)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return record{}, err
	}
	proof, err := guardkernel.Attach(m.object, pin, group)
	if err != nil {
		return record{}, err
	}
	inventory, err := m.sampler.Sample(ctx, m.inventory)
	if err != nil {
		return record{}, err
	}
	absolute, err := guardkernel.DeadlineNS(inventory.Expires)
	if err != nil || absolute == 0 {
		return record{}, fmt.Errorf("invalid Cloud guard absolute cutoff")
	}
	next := record{
		Box: box, Instance: instance, DataSocket: dataSocket, Revision: inventory.Revision,
		Digest: inventory.Digest, HostAddresses: inventory.HostAddrs, AbsoluteCutoff: absolute, Kernel: proof,
	}
	if err := m.store(next); err != nil {
		return record{}, err
	}
	lease, err := guardkernel.DeadlineNS(inventory.SampledAt.Add(guardinventory.Freshness))
	if err != nil || lease == 0 {
		return record{}, fmt.Errorf("Cloud inventory freshness expired during installation")
	}
	if err := guardkernel.SetDeadline(pin, min(lease, absolute)); err != nil {
		return record{}, err
	}
	return next, nil
}

func (m *manager) store(next record) error {
	file, err := os.CreateTemp(m.records, ".guard-")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	writeErr := json.NewEncoder(file).Encode(next)
	if err := errors.Join(writeErr, file.Close()); err != nil {
		return err
	}
	return os.Rename(file.Name(), m.recordPath(next.Box))
}

func (m *manager) prove(stored record) (uint64, error) {
	if stored.ShimPID != 0 && !m.sameShim(stored) {
		return 0, fmt.Errorf("Cloud guard shim identity is inactive")
	}
	proof, err := guardkernel.Inspect(m.pinDir(stored.Box), m.cgroup(stored.Box))
	if err != nil || proof != stored.Kernel {
		return 0, fmt.Errorf("active kernel guard does not match the Box record")
	}
	deadline, err := guardkernel.CurrentDeadline(m.pinDir(stored.Box))
	if err != nil {
		return 0, err
	}
	now, err := guardkernel.NowNS()
	if err != nil {
		return 0, err
	}
	if deadline <= now || deadline > stored.AbsoluteCutoff {
		return 0, fmt.Errorf("Cloud kernel guard is inactive")
	}
	return deadline, nil
}

func (m *manager) release(box, instance string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, preparing := m.preparing[box]; preparing {
		return fmt.Errorf("Cloud guard is preparing this Box")
	}
	raw, err := os.ReadFile(m.recordPath(box))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var stored record
	if err := json.Unmarshal(raw, &stored); err != nil || stored.Box != box || stored.Instance != instance {
		return fmt.Errorf("release requires the verified Cloud guard instance")
	}
	if err := guardkernel.Remove(m.pinDir(box), m.cgroup(box)); err != nil {
		return err
	}
	delete(m.active, box)
	delete(m.retired, box)
	return os.Remove(m.recordPath(box))
}

func (m *manager) get(box, instance string) (record, error) {
	stored, ok := m.active[box]
	if !ok || subtle.ConstantTimeCompare([]byte(stored.Instance), []byte(instance)) != 1 {
		return record{}, fmt.Errorf("unknown Cloud guard instance")
	}
	return stored, nil
}

func (m *manager) watch(ctx context.Context) {
	ticker := time.NewTicker(guardinventory.PollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			current, err := m.sampler.Sample(ctx, m.inventory)
			m.refresh(current, err)
			m.reapRetired()
		}
	}
}

func (m *manager) refresh(current guardinventory.Observation, readErr error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var lease uint64
	if readErr == nil {
		lease, readErr = guardkernel.DeadlineNS(current.SampledAt.Add(guardinventory.Freshness))
	}
	for box, stored := range m.active {
		if readErr != nil || lease == 0 || current.Revision != stored.Revision ||
			current.Digest != stored.Digest || !slices.Equal(current.HostAddrs, stored.HostAddresses) {
			_ = m.revoke(box)
			continue
		}
		prior, err := m.prove(stored)
		if err != nil {
			_ = m.revoke(box)
			continue
		}
		if stored.ShimPID == 0 {
			populated, err := guardkernel.Populated(m.cgroup(box))
			if err != nil {
				_ = m.revoke(box)
				continue
			}
			if !populated {
				// Let an abandoned pre-spawn reservation expire.
				continue
			}
		}
		if renewed, err := guardkernel.RenewDeadline(m.pinDir(box), prior, min(lease, stored.AbsoluteCutoff)); err != nil || !renewed {
			_ = m.revoke(box)
		}
	}
}

func (m *manager) revoke(box string) error {
	delete(m.active, box)
	m.retired[box] = struct{}{}
	if err := guardkernel.SetDeadline(m.pinDir(box), 0); err != nil {
		log.Printf("Cloud guard revocation map write failed for Box %q: %v", box, err)
		return err
	}
	return nil
}

func (m *manager) reapRetired() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for box := range m.retired {
		populated, err := guardkernel.Populated(m.cgroup(box))
		if populated || (err != nil && !errors.Is(err, os.ErrNotExist)) {
			continue
		}
		if err := guardkernel.Remove(m.pinDir(box), m.cgroup(box)); err != nil {
			continue
		}
		if err := os.Remove(m.recordPath(box)); err == nil || errors.Is(err, os.ErrNotExist) {
			delete(m.retired, box)
		}
	}
}
