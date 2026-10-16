package boxlite

/*
#include "bridge.h"
#include <stdlib.h>
*/
import "C"
import (
	"context"
	"encoding/json"
	"fmt"
	"runtime/cgo"
	"unsafe"
)

// Git is a box-scoped handle for read-only git operations.
type Git struct {
	handle  *C.CBoxGitHandle
	runtime *Runtime
}

// Git returns the box-scoped handle for git operations.
func (b *Box) Git() (*Git, error) {
	if b == nil || b.handle == nil {
		return nil, ErrRuntimeClosed
	}

	var cGit *C.CBoxGitHandle
	var cerr C.CBoxliteError
	code := C.boxlite_box_git(b.handle, &cGit, &cerr)
	if code != C.Ok {
		return nil, freeError(&cerr)
	}

	return &Git{handle: cGit, runtime: b.runtime}, nil
}

// Close releases the git handle.
func (g *Git) Close() error {
	if g != nil && g.handle != nil {
		C.boxlite_git_free(g.handle)
		g.handle = nil
	}
	return nil
}

// GitFileStatus is one changed path in a GitStatus. IndexStatus and
// WorktreeStatus are git's porcelain v2 XY codes ("." unchanged, "?" untracked).
type GitFileStatus struct {
	Path           string  `json:"path"`
	OrigPath       *string `json:"orig_path"`
	IndexStatus    string  `json:"index_status"`
	WorktreeStatus string  `json:"worktree_status"`
}

// Staged reports whether the path has staged changes.
func (f GitFileStatus) Staged() bool { return f.IndexStatus != "." && f.IndexStatus != "?" }

// Untracked reports whether the path is untracked.
func (f GitFileStatus) Untracked() bool { return f.IndexStatus == "?" }

// GitStatus is the structured result of Git.Status.
type GitStatus struct {
	CurrentBranch   *string         `json:"current_branch"`
	Upstream        *string         `json:"upstream"`
	Ahead           uint32          `json:"ahead"`
	Behind          uint32          `json:"behind"`
	BranchPublished bool            `json:"branch_published"`
	HeadCommit      *string         `json:"head_commit"`
	FileStatus      []GitFileStatus `json:"file_status"`
}

// GitBranches is the structured result of Git.Branches.
type GitBranches struct {
	Current *string  `json:"current"`
	Names   []string `json:"names"`
}

// Status returns the structured working-tree status of the repository at path.
func (g *Git) Status(ctx context.Context, path string) (*GitStatus, error) {
	out := &GitStatus{}
	if err := g.queryJSON(ctx, path, true, out); err != nil {
		return nil, err
	}
	return out, nil
}

// Branches returns the local branches of the repository at path.
func (g *Git) Branches(ctx context.Context, path string) (*GitBranches, error) {
	out := &GitBranches{}
	if err := g.queryJSON(ctx, path, false, out); err != nil {
		return nil, err
	}
	return out, nil
}

func (g *Git) queryJSON(ctx context.Context, path string, status bool, out any) error {
	if g == nil || g.handle == nil || g.runtime == nil {
		return ErrRuntimeClosed
	}
	g.runtime.ensureDrainRunning()

	cPath := toCString(path)
	defer C.free(unsafe.Pointer(cPath))

	result := make(chan handleResult[*C.char], 1)
	h := registerHandleForDispatch(cgo.NewHandle(result))

	var cerr C.CBoxliteError
	var ok bool
	if status {
		ok = C.boxlite_git_status(g.handle, cPath, C.cbGitJSON(), handleToPtr(h), &cerr) == C.Ok
	} else {
		ok = C.boxlite_git_branches(g.handle, cPath, C.cbGitJSON(), handleToPtr(h), &cerr) == C.Ok
	}
	if !ok {
		deleteHandleForDispatch(h)
		return freeError(&cerr)
	}

	dispose := func(value *C.char) {
		if value != nil {
			freeBoxliteString(value)
		}
	}
	select {
	case completed := <-result:
		defer dispose(completed.value)
		if completed.err != nil {
			return completed.err
		}
		if err := json.Unmarshal([]byte(cString(completed.value)), out); err != nil {
			return fmt.Errorf("boxlite: decode git result: %w", err)
		}
		return nil
	case <-ctx.Done():
		abandonOwnedResult(result, h, dispose)
		return ctx.Err()
	case <-g.runtime.closing:
		abandonOwnedResult(result, h, dispose)
		return ErrRuntimeClosed
	}
}
