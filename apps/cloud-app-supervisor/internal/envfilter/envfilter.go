// Package envfilter decides which parts of the supervisor's own environment
// may reach application code, and parses the supervisor's boolean knobs. It is
// the only place either rule lives, so the root bootstrap (internal/privilege)
// and a non-root run (main) hand services exactly the same environment.
package envfilter

import "strings"

// DefaultPath is used when neither the environment nor the Box names a PATH.
const DefaultPath = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

// App returns environ minus everything that must never reach application
// code: the box token and control-plane coordinates, the SV_* knobs, sudo's
// bookkeeping (SUDO_*) and any PORT the runner happened to set. PATH is
// replaced by boxPath when given (sudo's secure_path has already overwritten
// the image's PATH by the time a root supervisor runs) and is always present.
func App(environ []string, boxPath string) []string {
	var out []string
	hasPath := false
	for _, kv := range environ {
		k, _, _ := strings.Cut(kv, "=")
		switch {
		case k == "BOXLITE_CP_URL", k == "BOXLITE_BOX_TOKEN", k == "BOXLITE_ENV_ID", k == "PORT":
			continue
		case strings.HasPrefix(k, "SV_"), strings.HasPrefix(k, "SUDO_"):
			continue
		case k == "PATH":
			if boxPath != "" {
				kv = "PATH=" + boxPath
			}
			hasPath = true
		}
		out = append(out, kv)
	}
	if !hasPath {
		p := boxPath
		if p == "" {
			p = DefaultPath
		}
		out = append(out, "PATH="+p)
	}
	return out
}

// On reports whether a knob such as SV_CP_INSECURE is switched on.
func On(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}
