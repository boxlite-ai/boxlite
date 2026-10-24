package proc

import "syscall"

// Cred is the unprivileged identity that services and build steps run as when
// the supervisor itself is root (contracts.md 2.1). nil means "as the
// supervisor", which is what tests and local runs use.
type Cred struct {
	UID, GID uint32
	Home     string // HOME, also the fallback working directory
	Name     string // USER and LOGNAME
}

// sysProcAttr returns the attributes every child gets: its own process group
// (so signals reach the whole tree) and, with c set, the dropped identity with
// no supplementary groups, so a root supervisor's groups never leak into app
// code.
func (c *Cred) sysProcAttr() *syscall.SysProcAttr {
	a := &syscall.SysProcAttr{Setpgid: true}
	if c != nil {
		a.Credential = &syscall.Credential{Uid: c.UID, Gid: c.GID, Groups: []uint32{}}
	}
	return a
}
