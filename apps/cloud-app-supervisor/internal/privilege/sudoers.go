package privilege

import (
	"fmt"
	"strings"
)

// disabledMark prefixes every sudoers line the supervisor switched off, so a
// human reading the file sees why and the edit is idempotent.
const disabledMark = "# disabled by microcloud supervisor: "

// Principal is the account whose sudo rights are being removed.
type Principal struct {
	User   string   // boxlite
	UID    int      // 1001
	Groups []string // every group the user is in, primary included
}

// matches reports whether one entry of a sudoers User_List names p.
func (p Principal) matches(entry string, aliases map[string][]string, depth int) bool {
	e := strings.TrimSpace(entry)
	e = strings.TrimLeft(e, "!") // a negated entry still concerns the user; treat it as a match and disable the line
	switch {
	case e == "":
		return false
	case e == "ALL":
		return true
	case e == p.User, e == fmt.Sprintf("#%d", p.UID):
		return true
	case strings.HasPrefix(e, "%:"), strings.HasPrefix(e, "%#"):
		// non-Unix group / gid: be conservative and match any of the user's.
		return true
	case strings.HasPrefix(e, "%"):
		g := strings.TrimPrefix(e, "%")
		for _, mine := range p.Groups {
			if g == mine {
				return true
			}
		}
		return false
	case strings.HasPrefix(e, "+"):
		return true // netgroup: cannot resolve here, assume it covers the user
	}
	if members, ok := aliases[e]; ok && depth < 8 {
		for _, m := range members {
			if p.matches(m, aliases, depth+1) {
				return true
			}
		}
	}
	return false
}

// logicalLines groups physical lines joined by trailing backslashes.
func logicalLines(content string) [][]string {
	var out [][]string
	var cur []string
	for _, line := range strings.Split(content, "\n") {
		cur = append(cur, line)
		if strings.HasSuffix(strings.TrimRight(line, " \t"), "\\") {
			continue
		}
		out = append(out, cur)
		cur = nil
	}
	if cur != nil {
		out = append(out, cur)
	}
	return out
}

func joinLogical(phys []string) string {
	parts := make([]string, len(phys))
	for i, l := range phys {
		parts[i] = strings.TrimSuffix(strings.TrimRight(l, " \t"), "\\")
	}
	return strings.TrimSpace(strings.Join(parts, " "))
}

// isComment reports whether a logical line is a comment (and not one of the
// `#include`, `#includedir` directives or a `#<uid>` user spec).
func isComment(l string) bool {
	if !strings.HasPrefix(l, "#") {
		return false
	}
	if strings.HasPrefix(l, "#include") {
		return false
	}
	rest := strings.TrimPrefix(l, "#")
	if rest != "" && rest[0] >= '0' && rest[0] <= '9' {
		// "#1001 ALL=(ALL) ALL" is a uid user spec, "#1 comment" is a comment;
		// a spec has an '=' after the user and host lists.
		return !strings.Contains(rest, "=")
	}
	return true
}

// UserAliases collects `User_Alias NAME = a, b : OTHER = c` definitions.
func UserAliases(contents ...string) map[string][]string {
	out := map[string][]string{}
	for _, content := range contents {
		for _, phys := range logicalLines(content) {
			l := joinLogical(phys)
			if !strings.HasPrefix(l, "User_Alias") {
				continue
			}
			for _, def := range strings.Split(strings.TrimSpace(strings.TrimPrefix(l, "User_Alias")), ":") {
				name, members, ok := strings.Cut(def, "=")
				if !ok {
					continue
				}
				for _, m := range strings.Split(members, ",") {
					out[strings.TrimSpace(name)] = append(out[strings.TrimSpace(name)], strings.TrimSpace(m))
				}
			}
		}
	}
	return out
}

// Neutralise comments out every user specification in content that grants
// anything to p (directly, by uid, through one of p's groups, an alias, or
// ALL). Defaults, aliases and include directives stay. It returns the new
// content and whether anything changed.
func Neutralise(content string, p Principal, aliases map[string][]string) (string, bool) {
	changed := false
	var out []string
	for _, phys := range logicalLines(content) {
		l := joinLogical(phys)
		if l == "" || isComment(l) || !isUserSpec(l) {
			out = append(out, phys...)
			continue
		}
		users := l
		if i := strings.IndexAny(l, " \t"); i >= 0 {
			users = l[:i]
		}
		hit := false
		for _, u := range strings.Split(users, ",") {
			if p.matches(u, aliases, 0) {
				hit = true
				break
			}
		}
		if !hit {
			out = append(out, phys...)
			continue
		}
		changed = true
		for _, line := range phys {
			out = append(out, disabledMark+line)
		}
	}
	return strings.Join(out, "\n"), changed
}

func isUserSpec(l string) bool {
	for _, kw := range []string{"Defaults", "User_Alias", "Runas_Alias", "Host_Alias", "Cmnd_Alias", "Cmd_Alias", "@include", "#include"} {
		if strings.HasPrefix(l, kw) {
			return false
		}
	}
	return strings.Contains(l, "=")
}

// OnlyLauncher checks the output of `sudo -l -U <user>`: every command line
// listed must be the launcher. It returns false for "not allowed to run sudo"
// too, because then the next Box start could not become root.
func OnlyLauncher(listing, launcher string) bool {
	_, after, ok := strings.Cut(listing, "may run the following commands")
	if !ok {
		return false
	}
	seen := false
	for _, line := range strings.Split(after, "\n") {
		t := strings.TrimSpace(line)
		if t == "" || strings.HasPrefix(t, "on ") || strings.HasSuffix(t, ":") && !strings.Contains(t, "/") {
			continue
		}
		if !strings.HasPrefix(t, "(") {
			continue // continuation of the header ("on <host>:")
		}
		// "(root) NOPASSWD: /usr/local/sbin/microcloud-sv """
		_, cmds, _ := strings.Cut(t, ")")
		for _, tag := range []string{"NOPASSWD:", "PASSWD:", "SETENV:", "NOSETENV:", "EXEC:", "NOEXEC:"} {
			cmds = strings.ReplaceAll(cmds, tag, "")
		}
		for _, c := range strings.Split(cmds, ",") {
			c = strings.TrimSpace(c)
			if c != launcher+` ""` && c != launcher {
				return false
			}
			seen = true
		}
	}
	return seen
}
