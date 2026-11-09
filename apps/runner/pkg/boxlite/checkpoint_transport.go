// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package boxlite

import (
	"archive/tar"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"

	sdk "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/klauspost/compress/zstd"
)

const checkpointTransferLimit int64 = 16 * 1024 * 1024 * 1024

type checkpointTransportReader struct {
	reader   io.Reader
	position int64
}

func (r *checkpointTransportReader) Read(buffer []byte) (int, error) {
	n, e := r.reader.Read(buffer)
	r.position += int64(n)
	return n, e
}

func validCheckpointURI(raw, organization string) bool {
	u, e := url.Parse(raw)
	if e != nil || u.Scheme != "gs" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.RawPath != "" || u.Path == "" || path.Clean(u.Path) != u.Path {
		return false
	}
	if organization == "" {
		return true
	}
	for _, segment := range strings.Split(u.Path, "/") {
		if segment == organization {
			return true
		}
	}
	return false
}

func checkpointStorageError(err error) error {
	if err == nil {
		return nil
	}
	return checkpointError(sdk.ErrStorage, err.Error())
}
func checkpointTransportError(err error) error {
	var fs *os.PathError
	if errors.As(err, &fs) || errors.Is(err, io.ErrShortWrite) {
		return checkpointStorageError(err)
	}
	return checkpointError(sdk.ErrInvalidArgument, "invalid checkpoint transport")
}

// Pair transfer is the same two regular USTAR members and zstd
// stream as checkpoint_transport.rs. Nothing is extracted to a supplied path.
func unpackCheckpointPair(input io.Reader, destination string) error {
	decoder, e := zstd.NewReader(input, zstd.WithDecoderMaxMemory(64<<20), zstd.IgnoreChecksum(true))
	if e != nil {
		return checkpointTransportError(e)
	}
	defer decoder.Close()
	counted := &checkpointTransportReader{reader: decoder}
	archive := tar.NewReader(counted)
	if e = os.Mkdir(destination, 0700); e != nil {
		return checkpointStorageError(e)
	}
	seen := map[string]bool{}
	var total int64
	var padding int64
	for {
		before := counted.position
		header, e := archive.Next()
		if errors.Is(e, io.EOF) {
			break
		}
		if e != nil {
			return checkpointTransportError(e)
		}
		if (header.Name != "snapshot.mem" && header.Name != "snapshot.qcow2") || header.Typeflag != tar.TypeReg || counted.position-before != padding+512 || len(header.PAXRecords) != 0 || seen[header.Name] || header.Size <= 0 || header.Size > checkpointTransferLimit-total {
			return checkpointError(sdk.ErrInvalidArgument, "checkpoint transfer requires exactly two bounded regular members")
		}
		seen[header.Name] = true
		total += header.Size
		padding = (512 - header.Size%512) % 512
		file, e := os.OpenFile(filepath.Join(destination, header.Name), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if e != nil {
			return checkpointStorageError(e)
		}
		n, copyErr := io.Copy(file, archive)
		syncErr := file.Sync()
		closeErr := file.Close()
		if copyErr != nil {
			return checkpointTransportError(copyErr)
		}
		if n != header.Size {
			return checkpointError(sdk.ErrInvalidArgument, "truncated checkpoint member")
		}
		if syncErr != nil {
			return checkpointStorageError(syncErr)
		}
		if closeErr != nil {
			return checkpointStorageError(closeErr)
		}
	}
	if len(seen) != 2 {
		return checkpointError(sdk.ErrInvalidArgument, "checkpoint transfer requires two members")
	}
	tail, e := io.ReadAll(io.LimitReader(decoder, 65537))
	if e != nil {
		return checkpointTransportError(e)
	}
	if len(tail) > 65536 || len(tail)%512 != 0 {
		return checkpointError(sdk.ErrInvalidArgument, "invalid checkpoint footer")
	}
	for _, b := range tail {
		if b != 0 {
			return checkpointError(sdk.ErrInvalidArgument, "checkpoint transport contains trailing data")
		}
	}
	return nil
}

func packCheckpointPair(directory, destination string) error {
	output, e := os.CreateTemp(filepath.Dir(destination), ".pair-export-")
	if e != nil {
		return checkpointStorageError(e)
	}
	defer output.Close()
	defer os.Remove(output.Name())
	encoder, e := zstd.NewWriter(output, zstd.WithEncoderCRC(false))
	if e != nil {
		return e
	}
	defer encoder.Close()
	archive := tar.NewWriter(encoder)
	defer archive.Close()
	for _, name := range []string{"snapshot.mem", "snapshot.qcow2"} {
		file, e := os.Open(filepath.Join(directory, name))
		if e != nil {
			return checkpointStorageError(e)
		}
		stat, e := file.Stat()
		if e != nil {
			file.Close()
			return checkpointStorageError(e)
		}
		format := tar.FormatUSTAR
		if stat.Size() > 8589934591 {
			format = tar.FormatGNU
		}
		e = archive.WriteHeader(&tar.Header{Name: name, Mode: 0600, Size: stat.Size(), Typeflag: tar.TypeReg, Format: format})
		if e == nil {
			_, e = io.Copy(archive, file)
		}
		_ = file.Close()
		if e != nil {
			return checkpointStorageError(e)
		}
	}
	if e = archive.Close(); e != nil {
		return checkpointStorageError(e)
	}
	if e = encoder.Close(); e != nil {
		return checkpointStorageError(e)
	}
	if e = output.Sync(); e != nil {
		return checkpointStorageError(e)
	}
	if e = output.Close(); e != nil {
		return checkpointStorageError(e)
	}
	return checkpointStorageError(os.Link(output.Name(), destination))
}

type checkpointArchiveManifest struct {
	Version        int    `json:"version"`
	MetadataSHA256 string `json:"metadata_sha256"`
	Members        map[string]struct {
		Length int64  `json:"length"`
		SHA256 string `json:"sha256"`
	} `json:"members"`
}

func openCheckpointArchive(archivePath string) (*os.File, *zstd.Decoder, *tar.Reader, *checkpointArchiveManifest, error) {
	file, e := os.Open(archivePath)
	if e != nil {
		return nil, nil, nil, nil, checkpointStorageError(e)
	}
	decoder, e := zstd.NewReader(file, zstd.WithDecoderMaxMemory(64<<20), zstd.IgnoreChecksum(true))
	if e != nil {
		file.Close()
		return nil, nil, nil, nil, checkpointStorageError(e)
	}
	archive := tar.NewReader(decoder)
	header, e := archive.Next()
	if e != nil || header.Name != "manifest.json" || header.Typeflag != tar.TypeReg || header.Size <= 0 || header.Size > 65536 {
		decoder.Close()
		file.Close()
		return nil, nil, nil, nil, checkpointError(sdk.ErrStorage, "invalid managed checkpoint manifest")
	}
	var manifest checkpointArchiveManifest
	e = json.NewDecoder(archive).Decode(&manifest)
	if e != nil || (manifest.Version != 1 && manifest.Version != 2) || !validDigest(manifest.Members["boot.raw"].SHA256) || manifest.Members["boot.raw"].Length <= 0 {
		decoder.Close()
		file.Close()
		return nil, nil, nil, nil, checkpointError(sdk.ErrStorage, "invalid managed boot manifest")
	}
	return file, decoder, archive, &manifest, nil
}

func checkpointArchiveIdentity(archivePath string) (*checkpointArchiveManifest, error) {
	f, d, _, m, e := openCheckpointArchive(archivePath)
	if e != nil {
		return nil, e
	}
	defer f.Close()
	defer d.Close()
	if m.Version != 2 || !validDigest(m.MetadataSHA256) {
		return nil, checkpointError(sdk.ErrUnsupported, "cloud restore requires managed archive v2; re-export the checkpoint")
	}
	return m, nil
}

// Only a server-authorized managed archive may supply boot.raw. Native then
// uses this owned copy, never the uploaded pair's saved pathname.
func extractCheckpointBoot(archivePath, destination, expected string) error {
	file, decoder, archive, manifest, e := openCheckpointArchive(archivePath)
	if e != nil {
		return e
	}
	defer file.Close()
	defer decoder.Close()
	boot := manifest.Members["boot.raw"]
	if boot.SHA256 != expected || boot.Length > checkpointTransferLimit {
		return checkpointError(sdk.ErrStorage, "trusted boot manifest differs from checkpoint")
	}
	for {
		header, e := archive.Next()
		if e != nil {
			return checkpointError(sdk.ErrStorage, "trusted boot member is missing")
		}
		if header.Name != "boot.raw" {
			continue
		}
		if header.Typeflag != tar.TypeReg || header.Size != boot.Length {
			return checkpointError(sdk.ErrStorage, "invalid trusted boot member")
		}
		output, e := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if e != nil {
			return checkpointStorageError(e)
		}
		n, copyErr := io.Copy(output, archive)
		syncErr := output.Sync()
		closeErr := output.Close()
		if copyErr != nil {
			return checkpointStorageError(copyErr)
		}
		if syncErr != nil {
			return checkpointStorageError(syncErr)
		}
		if closeErr != nil {
			return checkpointStorageError(closeErr)
		}
		if n != boot.Length {
			return checkpointError(sdk.ErrStorage, "trusted boot length mismatch")
		}
		return nil
	}
}
