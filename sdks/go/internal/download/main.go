// Download prebuilt libboxlite from GitHub Releases.
//
// This tool downloads the correct platform-specific archive from the BoxLite
// GitHub Releases and extracts it to pkg/boxlite/lib/{platform}/.
//
// Usage:
//
//	go run github.com/boxlite-ai/boxlite/sdks/go/internal/download [@version]
//
// If no version is specified, downloads the latest release.
package main

import (
	"archive/tar"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const (
	repo          = "boxlite-ai/boxlite"
	apiBase       = "https://api.github.com/repos/" + repo
	archivePrefix = "boxlite-c-"
)

var httpClient = &http.Client{Timeout: 5 * time.Minute}

func main() {
	version := ""
	if len(os.Args) > 1 {
		version = os.Args[1]
	}

	platform := detectPlatform()
	fmt.Printf("Platform: %s\n", platform)

	// Find the Go module root (where go.mod lives)
	libDir := findLibDir()

	if version == "" {
		var err error
		version, err = latestRelease()
		if err != nil {
			fatalf("failed to get latest release: %v", err)
		}
	}
	if !strings.HasPrefix(version, "v") {
		version = "v" + version
	}
	fmt.Printf("Version: %s\n", version)

	archiveName := fmt.Sprintf("%s%s-%s.tar.gz", archivePrefix, version, platform)
	url := fmt.Sprintf("https://github.com/%s/releases/download/%s/%s", repo, version, archiveName)
	fmt.Printf("Downloading: %s\n", url)

	if err := downloadAndExtract(url, platform, libDir); err != nil {
		fatalf("download failed: %v", err)
	}

	fmt.Printf("Library installed to: %s\n", filepath.Join(libDir, platform))
}

// detectPlatform maps GOOS/GOARCH to the BoxLite platform target name.
func detectPlatform() string {
	switch {
	case runtime.GOOS == "darwin" && runtime.GOARCH == "arm64":
		return "darwin-arm64"
	case runtime.GOOS == "linux" && runtime.GOARCH == "amd64":
		return "linux-x64-gnu"
	default:
		fatalf("unsupported platform: %s/%s", runtime.GOOS, runtime.GOARCH)
		return ""
	}
}

// findLibDir locates the lib directory inside pkg/boxlite/.
// Works whether run from the repo root or from sdks/go/.
func findLibDir() string {
	// Try to find go.mod to locate the module root
	dir, err := os.Getwd()
	if err != nil {
		fatalf("cannot get working directory: %v", err)
	}

	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return filepath.Join(dir, "pkg", "boxlite", "lib")
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}

	fatalf("cannot find go.mod — run from within the Go SDK directory")
	return ""
}

// latestRelease fetches the latest release tag from GitHub.
func latestRelease() (string, error) {
	resp, err := httpClient.Get(apiBase + "/releases/latest")
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("GitHub API returned %d", resp.StatusCode)
	}

	var release struct {
		TagName string `json:"tag_name"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&release); err != nil {
		return "", err
	}
	return release.TagName, nil
}

// downloadAndExtract downloads a .tar.gz archive and extracts lib/ and include/.
func downloadAndExtract(url, platform, libDir string) error {
	resp, err := httpClient.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download returned HTTP %d (check version and platform)", resp.StatusCode)
	}

	gz, err := gzip.NewReader(resp.Body)
	if err != nil {
		return fmt.Errorf("gzip: %w", err)
	}
	defer gz.Close()

	tr := tar.NewReader(gz)

	platformDir := filepath.Join(libDir, platform)
	includeDir := filepath.Join(libDir, "include")

	if err := os.MkdirAll(platformDir, 0o755); err != nil {
		return err
	}
	if err := os.MkdirAll(includeDir, 0o755); err != nil {
		return err
	}

	extracted := 0
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return fmt.Errorf("tar: %w", err)
		}

		// Archive structure: boxlite-c-vX.Y.Z-platform/{lib,include}/filename
		name := hdr.Name
		parts := strings.SplitN(name, "/", 3)
		if len(parts) < 3 || hdr.Typeflag != tar.TypeReg {
			continue
		}

		subdir := parts[1] // "lib" or "include"
		fname := parts[2]  // filename

		var destDir string
		switch subdir {
		case "lib":
			destDir = platformDir
		case "include":
			destDir = includeDir
		default:
			continue
		}

		dest := filepath.Join(destDir, fname)
		// Prevent path traversal
		if !strings.HasPrefix(filepath.Clean(dest), filepath.Clean(destDir)) {
			continue
		}

		f, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, os.FileMode(hdr.Mode)&0o755)
		if err != nil {
			return fmt.Errorf("create %s: %w", dest, err)
		}
		if _, err := io.Copy(f, tr); err != nil {
			f.Close()
			return fmt.Errorf("write %s: %w", dest, err)
		}
		f.Close()
		extracted++
		fmt.Printf("  extracted: %s/%s\n", subdir, fname)
	}

	if extracted == 0 {
		return fmt.Errorf("no files extracted from archive")
	}
	return nil
}

func fatalf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "boxlite-download: "+format+"\n", args...)
	os.Exit(1)
}
