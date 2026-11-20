//go:build linux

// Package guardkernel installs and inspects a Box's pinned Linux deadline guard.
package guardkernel

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"time"

	"github.com/cilium/ebpf"
	"github.com/cilium/ebpf/link"
	"golang.org/x/sys/unix"
)

const (
	deadlineMap    = "cloud_deadline"
	guestMap       = "cloud_guest"
	renewalProgram = "cloud_renew"
)

var hooks = [...]struct {
	name   string
	attach ebpf.AttachType
}{
	{"cloud_connect", ebpf.AttachLSMCgroup},
	{"cloud_send", ebpf.AttachLSMCgroup},
	{"cloud_egress", ebpf.AttachCGroupInetEgress},
}

type programIdentity struct {
	Program ebpf.ProgramID `json:"program"`
	Link    link.ID        `json:"link"`
	Tag     string         `json:"tag"`
}

type Proof struct {
	CgroupID       uint64             `json:"cgroup_id"`
	Programs       [3]programIdentity `json:"programs"`
	DeadlineMap    ebpf.MapID         `json:"deadline_map"`
	RenewalProgram programIdentity    `json:"renewal_program"`
	GuestMap       ebpf.MapID         `json:"guest_map"`
}

// Attach provisions a new guard with a closed deadline. The caller owns
// cgroup placement and keeps the cgroup empty until Attach succeeds.
func Attach(object, directory, cgroup string) (_ Proof, err error) {
	group, id, err := openGroup(cgroup)
	if err != nil {
		return Proof{}, err
	}
	defer group.Close()
	if err := requireEmpty(group); err != nil {
		return Proof{}, err
	}
	if err := os.Mkdir(directory, 0o700); err != nil {
		return Proof{}, fmt.Errorf("create Cloud guard pin directory: %w", err)
	}
	var pins []string
	defer func() {
		if err != nil {
			for _, path := range pins {
				_ = os.Remove(path)
			}
			_ = os.Remove(directory)
		}
	}()

	programDir := filepath.Join(directory, "programs")
	if err := os.Mkdir(programDir, 0o700); err != nil {
		return Proof{}, err
	}
	defer os.RemoveAll(programDir)
	for _, name := range []string{deadlineMap, guestMap} {
		pins = append(pins, filepath.Join(directory, name))
	}
	// Ubuntu's bpftool/libbpf resolves the BTF attach target for cgroup LSM
	// programs. The Go library's pinned release handles live object and
	// link APIs, but cannot populate that target during the ELF load.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, "bpftool", "prog", "loadall", object, programDir, "pinmaps", directory).CombinedOutput()
	if err != nil {
		return Proof{}, fmt.Errorf("load Cloud guard BPF object: %w: %s", err, output)
	}
	for _, hook := range hooks {
		program, err := ebpf.LoadPinnedProgram(filepath.Join(programDir, hook.name), nil)
		if err != nil {
			return Proof{}, fmt.Errorf("open loaded Cloud guard %s: %w", hook.name, err)
		}
		attached, err := link.AttachRawLink(link.RawLinkOptions{
			Target: int(group.Fd()), Program: program, Attach: hook.attach,
		})
		_ = program.Close()
		if err != nil {
			return Proof{}, fmt.Errorf("attach Cloud guard %s: %w", hook.name, err)
		}
		path := filepath.Join(directory, hook.name)
		pinErr := attached.Pin(path)
		_ = attached.Close()
		if pinErr != nil {
			return Proof{}, fmt.Errorf("pin Cloud guard link %s: %w", hook.name, pinErr)
		}
		pins = append(pins, path)
	}
	renewalPath := filepath.Join(directory, renewalProgram)
	if err := os.Rename(filepath.Join(programDir, renewalProgram), renewalPath); err != nil {
		return Proof{}, fmt.Errorf("pin Cloud guard renewal program: %w", err)
	}
	pins = append(pins, renewalPath)
	return inspect(directory, group, id)
}

func Inspect(directory, cgroup string) (Proof, error) {
	group, id, err := openGroup(cgroup)
	if err != nil {
		return Proof{}, err
	}
	defer group.Close()
	return inspect(directory, group, id)
}

func inspect(directory string, group *os.File, id uint64) (Proof, error) {
	deadline, err := openMap(directory, deadlineMap)
	if err != nil {
		return Proof{}, err
	}
	defer deadline.Close()
	guest, err := openMap(directory, guestMap)
	if err != nil {
		return Proof{}, err
	}
	defer guest.Close()
	deadlineID, err := mapID(deadline)
	if err != nil {
		return Proof{}, err
	}
	guestID, err := mapID(guest)
	if err != nil {
		return Proof{}, err
	}
	renewal, err := inspectRenewal(directory, deadlineID)
	if err != nil {
		return Proof{}, err
	}
	proof := Proof{CgroupID: id, DeadlineMap: deadlineID, GuestMap: guestID, RenewalProgram: renewal}
	for i, hook := range hooks {
		attached, err := link.LoadPinnedLink(filepath.Join(directory, hook.name), nil)
		if err != nil {
			return Proof{}, fmt.Errorf("open Cloud guard link %s: %w", hook.name, err)
		}
		info, err := attached.Info()
		_ = attached.Close()
		if err != nil {
			return Proof{}, err
		}
		groupInfo := info.Cgroup()
		if groupInfo == nil || groupInfo.CgroupId != id || ebpf.AttachType(groupInfo.AttachType) != hook.attach {
			return Proof{}, fmt.Errorf("Cloud guard %s is attached to a different cgroup or hook", hook.name)
		}
		wantedMaps := []ebpf.MapID{deadlineID}
		if hook.name == "cloud_send" {
			wantedMaps = append(wantedMaps, guestID)
		}
		tag, err := checkProgram(info.Program, hook.name, wantedMaps)
		if err != nil {
			return Proof{}, err
		}
		proof.Programs[i] = programIdentity{info.Program, info.ID, tag}
	}
	if err := verifyEffective(group, ebpf.AttachLSMCgroup, proof.Programs[0].Program, proof.Programs[1].Program); err != nil {
		return Proof{}, err
	}
	if err := verifyEffective(group, ebpf.AttachCGroupInetEgress, proof.Programs[2].Program); err != nil {
		return Proof{}, err
	}
	return proof, nil
}

func inspectRenewal(directory string, deadlineID ebpf.MapID) (programIdentity, error) {
	program, err := ebpf.LoadPinnedProgram(filepath.Join(directory, renewalProgram), nil)
	if err != nil {
		return programIdentity{}, err
	}
	defer program.Close()
	info, err := program.Info()
	if err != nil {
		return programIdentity{}, err
	}
	id, hasID := info.ID()
	ids, hasMaps := info.MapIDs()
	if !hasID || !hasMaps || info.Type != ebpf.SocketFilter || info.Name != renewalProgram ||
		info.Tag == "" || !slices.Equal(ids, []ebpf.MapID{deadlineID}) {
		return programIdentity{}, fmt.Errorf("Cloud guard renewal program does not reference the verified map")
	}
	return programIdentity{Program: id, Tag: info.Tag}, nil
}

func checkProgram(id ebpf.ProgramID, name string, want []ebpf.MapID) (string, error) {
	program, err := ebpf.NewProgramFromID(id)
	if err != nil {
		return "", fmt.Errorf("open live Cloud guard program %s: %w", name, err)
	}
	defer program.Close()
	info, err := program.Info()
	if err != nil {
		return "", err
	}
	ids, ok := info.MapIDs()
	slices.Sort(ids)
	slices.Sort(want)
	if info.Name != name || info.Tag == "" || !ok || !slices.Equal(ids, want) {
		return "", fmt.Errorf("Cloud guard program %s does not reference the verified maps", name)
	}
	return info.Tag, nil
}

func verifyEffective(group *os.File, hook ebpf.AttachType, want ...ebpf.ProgramID) error {
	result, err := link.QueryPrograms(link.QueryOptions{
		Target: int(group.Fd()), Attach: hook, QueryFlags: unix.BPF_F_QUERY_EFFECTIVE,
	})
	if err != nil {
		return fmt.Errorf("query Cloud guard %s: %w", hook, err)
	}
	found := make([]ebpf.ProgramID, 0, len(result.Programs))
	for _, program := range result.Programs {
		found = append(found, program.ID)
	}
	slices.Sort(found)
	slices.Sort(want)
	if !slices.Equal(found, want) {
		return fmt.Errorf("Cloud guard %s has unmatched effective programs", hook)
	}
	return nil
}

func openGroup(path string) (*os.File, uint64, error) {
	fd, err := unix.Open(path, unix.O_DIRECTORY|unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, 0, fmt.Errorf("open Box cgroup: %w", err)
	}
	var st unix.Stat_t
	var fs unix.Statfs_t
	if err = unix.Fstat(fd, &st); err == nil {
		err = unix.Fstatfs(fd, &fs)
	}
	if err != nil || fs.Type != unix.CGROUP2_SUPER_MAGIC {
		_ = unix.Close(fd)
		return nil, 0, fmt.Errorf("Cloud guard requires a verified cgroup v2 directory")
	}
	return os.NewFile(uintptr(fd), path), st.Ino, nil
}

func openMap(directory, name string) (*ebpf.Map, error) {
	m, err := ebpf.LoadPinnedMap(filepath.Join(directory, name), nil)
	if err != nil {
		return nil, fmt.Errorf("open Cloud guard map %s: %w", name, err)
	}
	if m.Type() != ebpf.Array || m.KeySize() != 4 || m.ValueSize() != 8 || m.MaxEntries() != 1 {
		_ = m.Close()
		return nil, fmt.Errorf("invalid Cloud guard map %s", name)
	}
	return m, nil
}

func mapID(m *ebpf.Map) (ebpf.MapID, error) {
	info, err := m.Info()
	if err != nil {
		return 0, err
	}
	id, ok := info.ID()
	if !ok || id == 0 {
		return 0, fmt.Errorf("Cloud guard map has no kernel ID")
	}
	return id, nil
}

func NowNS() (uint64, error) {
	var mono unix.Timespec
	if err := unix.ClockGettime(unix.CLOCK_MONOTONIC, &mono); err != nil {
		return 0, err
	}
	return uint64(mono.Nano()), nil
}

func DeadlineNS(deadline time.Time) (uint64, error) {
	now, err := NowNS()
	if err != nil {
		return 0, err
	}
	if remaining := time.Until(deadline); remaining > 0 {
		return now + uint64(remaining), nil
	}
	return 0, nil
}

// SetDeadline publishes the first lease or revokes it. A live lease renews
// through the kernel transition so delayed publication cannot revive it.
func SetDeadline(directory string, value uint64) error {
	m, err := openMap(directory, deadlineMap)
	if err != nil {
		return err
	}
	defer m.Close()
	return m.Update(uint32(0), value, ebpf.UpdateExist)
}

func RenewDeadline(directory string, prior, next uint64) (bool, error) {
	program, err := ebpf.LoadPinnedProgram(filepath.Join(directory, renewalProgram), nil)
	if err != nil {
		return false, err
	}
	defer program.Close()
	// The socket-filter runner strips the synthetic Ethernet header first.
	const header = 14
	var frame [header + 16]byte
	binary.NativeEndian.PutUint64(frame[header:], prior)
	binary.NativeEndian.PutUint64(frame[header+8:], next)
	result, err := program.Run(&ebpf.RunOptions{Data: frame[:]})
	return result == 1, err
}

func CurrentDeadline(directory string) (uint64, error) {
	m, err := openMap(directory, deadlineMap)
	if err != nil {
		return 0, err
	}
	defer m.Close()
	var deadline uint64
	err = m.Lookup(uint32(0), &deadline)
	return deadline, err
}

func Remove(directory, cgroup string) error {
	group, _, err := openGroup(cgroup)
	if err == nil {
		defer group.Close()
		if err := requireEmpty(group); err != nil {
			return err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	for _, hook := range hooks {
		if err := os.Remove(filepath.Join(directory, hook.name)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	for _, name := range []string{deadlineMap, guestMap, renewalProgram} {
		if err := os.Remove(filepath.Join(directory, name)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	if err := os.RemoveAll(filepath.Join(directory, "programs")); err != nil {
		return err
	}
	if err := os.Remove(directory); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// RegisterGuest fixes the socket identity for this cgroup's lifetime.
func RegisterGuest(directory string, cookie uint64) error {
	if cookie == 0 {
		return fmt.Errorf("invalid guest Unix socket cookie")
	}
	m, err := openMap(directory, guestMap)
	if err != nil {
		return err
	}
	defer m.Close()
	var registered uint64
	if err := m.Lookup(uint32(0), &registered); err != nil {
		return err
	}
	if registered != 0 {
		if registered != cookie {
			return fmt.Errorf("Cloud guard already has a different guest socket")
		}
		info, err := m.Info()
		if err != nil || info.Frozen() {
			return err
		}
	} else {
		if err := m.Update(uint32(0), cookie, ebpf.UpdateExist); err != nil {
			return err
		}
	}
	return m.Freeze()
}

func requireEmpty(group *os.File) error {
	populated, err := groupPopulated(group)
	if err != nil {
		return err
	}
	if populated {
		return fmt.Errorf("Cloud guard installation requires an empty Box cgroup")
	}
	return nil
}

func Populated(path string) (bool, error) {
	group, _, err := openGroup(path)
	if err != nil {
		return false, err
	}
	defer group.Close()
	return groupPopulated(group)
}

func groupPopulated(group *os.File) (bool, error) {
	fd, err := unix.Openat(int(group.Fd()), "cgroup.events", unix.O_RDONLY|unix.O_CLOEXEC, 0)
	if err != nil {
		return false, err
	}
	events := os.NewFile(uintptr(fd), "cgroup.events")
	defer events.Close()
	var key string
	var populated int
	if _, err := fmt.Fscan(events, &key, &populated); err != nil || key != "populated" || (populated != 0 && populated != 1) {
		return false, fmt.Errorf("cannot verify Box cgroup population")
	}
	return populated == 1, nil
}
