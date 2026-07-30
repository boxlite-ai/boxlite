// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package rollout

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// Tarball layout, shared with .github/workflows/build-runner-binary.yml. Every
// runner artifact carries all four entries — release build and dev build alike
// — so there is exactly one install path here and no "sidecar missing, proceed
// anyway" branch for a bad build to slip through.
const (
	entryBinary         = "boxlite-runner"
	entryGuestSHA256    = "boxlite-runner.guest.sha256"
	entryRuntimeSuffix  = "boxlite-runner.runtime-suffix"
	entryRuntimePayload = "boxlite-runtime.tar.gz"
)

// maxArtifactBytes bounds an untrusted-length download and each entry expanded
// out of it. The runner tarball is ~100MB; 1GiB leaves generous headroom while
// still refusing a stream that would fill the disk.
const maxArtifactBytes = 1 << 30

// Artifact is a downloaded, checksum-verified runner build, unpacked into a
// scratch directory.
type Artifact struct {
	Version        string
	SHA256         string
	BinaryPath     string
	RuntimePayload string
	GuestSHA256    string
	RuntimeSuffix  string
}

// Fetcher retrieves an artifact by URL. https:// comes from GitHub Releases;
// s3:// is a dev build in the RunnerBuilds bucket, read with the instance role.
type Fetcher struct {
	http *http.Client
	s3   *s3.Client
}

func NewFetcher(cfg aws.Config) *Fetcher {
	return &Fetcher{
		// Generous but bounded: the tarball is large and the link from a
		// runner subnet to GitHub is not always fast.
		http: &http.Client{Timeout: 15 * time.Minute},
		s3:   s3.NewFromConfig(cfg),
	}
}

// Fetch downloads the artifact named by desired, verifies it against the
// pinned checksum, and unpacks it into dir.
//
// The checksum is verified before anything is unpacked, so a corrupt or
// substituted artifact never reaches the filesystem beyond the scratch copy.
func (f *Fetcher) Fetch(ctx context.Context, desired DesiredState, dir string) (*Artifact, error) {
	tarballPath := filepath.Join(dir, "runner.tar.gz")
	if err := f.download(ctx, desired.URL, tarballPath); err != nil {
		return nil, err
	}

	sum, err := fileSHA256(tarballPath)
	if err != nil {
		return nil, err
	}
	if sum != desired.SHA256 {
		return nil, fmt.Errorf("artifact checksum mismatch for %s: want %s got %s", desired.URL, desired.SHA256, sum)
	}

	unpacked := filepath.Join(dir, "unpacked")
	if err := os.MkdirAll(unpacked, 0o755); err != nil {
		return nil, err
	}
	if err := extractTarGz(tarballPath, unpacked); err != nil {
		return nil, fmt.Errorf("unpack %s: %w", desired.URL, err)
	}

	artifact := &Artifact{
		Version:        desired.Version,
		SHA256:         desired.SHA256,
		BinaryPath:     filepath.Join(unpacked, entryBinary),
		RuntimePayload: filepath.Join(unpacked, entryRuntimePayload),
	}

	for name, path := range map[string]string{
		entryBinary:         artifact.BinaryPath,
		entryRuntimePayload: artifact.RuntimePayload,
	} {
		if _, err := os.Stat(path); err != nil {
			return nil, fmt.Errorf("artifact %s is missing %s", desired.Version, name)
		}
	}

	guestField, err := readFirstField(filepath.Join(unpacked, entryGuestSHA256))
	if err != nil {
		return nil, fmt.Errorf("artifact %s: %w", desired.Version, err)
	}
	if !sha256Pattern.MatchString(guestField) {
		return nil, fmt.Errorf("artifact %s has a malformed %s: %q", desired.Version, entryGuestSHA256, guestField)
	}
	artifact.GuestSHA256 = guestField

	suffix, err := os.ReadFile(filepath.Join(unpacked, entryRuntimeSuffix))
	if err != nil {
		return nil, fmt.Errorf("artifact %s: read %s: %w", desired.Version, entryRuntimeSuffix, err)
	}
	artifact.RuntimeSuffix = sanitizeSuffix(string(suffix))

	if err := os.Chmod(artifact.BinaryPath, 0o755); err != nil {
		return nil, err
	}
	return artifact, nil
}

func (f *Fetcher) download(ctx context.Context, rawURL, dest string) error {
	if strings.HasPrefix(rawURL, "s3://") {
		return f.downloadS3(ctx, rawURL, dest)
	}
	return f.downloadHTTP(ctx, rawURL, dest)
}

func (f *Fetcher) downloadHTTP(ctx context.Context, rawURL, dest string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return err
	}
	res, err := f.http.Do(req)
	if err != nil {
		return fmt.Errorf("download %s: %w", rawURL, err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("download %s: HTTP %d", rawURL, res.StatusCode)
	}
	return writeBounded(dest, res.Body)
}

func (f *Fetcher) downloadS3(ctx context.Context, rawURL, dest string) error {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return fmt.Errorf("parse %s: %w", rawURL, err)
	}
	key := strings.TrimPrefix(parsed.Path, "/")
	if parsed.Host == "" || key == "" {
		return fmt.Errorf("malformed s3 url %q (want s3://bucket/key)", rawURL)
	}

	out, err := f.s3.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(parsed.Host),
		Key:    aws.String(key),
	})
	if err != nil {
		return fmt.Errorf("download %s: %w", rawURL, err)
	}
	defer out.Body.Close()
	return writeBounded(dest, out.Body)
}

func writeBounded(dest string, src io.Reader) error {
	f, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer f.Close()

	written, err := io.Copy(f, io.LimitReader(src, maxArtifactBytes+1))
	if err != nil {
		return err
	}
	if written > maxArtifactBytes {
		return fmt.Errorf("artifact exceeds the %d byte limit", maxArtifactBytes)
	}
	return f.Sync()
}

func extractTarGz(tarball, dest string) error {
	f, err := os.Open(tarball)
	if err != nil {
		return err
	}
	defer f.Close()

	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	defer gz.Close()

	reader := tar.NewReader(gz)
	for {
		header, err := reader.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}

		// The archive is checksum-verified before we get here, but it is still
		// data from the network: refuse anything that would write outside dest.
		target, err := safeJoin(dest, header.Name)
		if err != nil {
			return err
		}

		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			out, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, os.FileMode(header.Mode).Perm())
			if err != nil {
				return err
			}
			written, err := io.Copy(out, io.LimitReader(reader, maxArtifactBytes+1))
			closeErr := out.Close()
			if err != nil {
				return err
			}
			if closeErr != nil {
				return closeErr
			}
			if written > maxArtifactBytes {
				return fmt.Errorf("tar entry %s exceeds the %d byte limit", header.Name, maxArtifactBytes)
			}
		case tar.TypeSymlink:
			// The runtime payload ships versioned .so symlinks (libkrunfw.so.5
			// -> libkrunfw.so.5.x.y); the link target must stay inside dest.
			if _, err := safeJoin(filepath.Dir(target), header.Linkname); err != nil {
				return fmt.Errorf("tar entry %s: %w", header.Name, err)
			}
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			_ = os.Remove(target)
			if err := os.Symlink(header.Linkname, target); err != nil {
				return err
			}
		default:
			// Devices, fifos and hard links have no business in these payloads.
			return fmt.Errorf("tar entry %s has unsupported type %q", header.Name, string(header.Typeflag))
		}
	}
}

// safeJoin resolves name under root, rejecting absolute paths and any ".."
// that would escape (CWE-22 / "zip slip").
func safeJoin(root, name string) (string, error) {
	if filepath.IsAbs(name) {
		return "", fmt.Errorf("tar entry %q is an absolute path", name)
	}
	target := filepath.Join(root, name)
	rel, err := filepath.Rel(root, target)
	if err != nil {
		return "", err
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("tar entry %q escapes the destination directory", name)
	}
	return target, nil
}

func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()

	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func readFirstField(path string) (string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read %s: %w", filepath.Base(path), err)
	}
	fields := strings.Fields(string(raw))
	if len(fields) == 0 {
		return "", fmt.Errorf("%s is empty", filepath.Base(path))
	}
	return fields[0], nil
}

// sanitizeSuffix keeps the runtime suffix usable as a single path segment.
// An empty result is legitimate — that is what a release build carries.
func sanitizeSuffix(raw string) string {
	return strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			return r
		case r == '.', r == '_', r == '-':
			return r
		default:
			return -1
		}
	}, strings.TrimSpace(raw))
}
