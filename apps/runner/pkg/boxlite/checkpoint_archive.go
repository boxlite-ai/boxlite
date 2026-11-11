// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package boxlite

import (
	"archive/tar"
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"

	"github.com/boxlite-ai/runner/pkg/checkpoint"
	"github.com/klauspost/compress/zstd"
)

var checkpointPlatformEnvKeys = []string{
	"BOXLITE_BOX_ID", "BOXLITE_OTEL_ENDPOINT", "BOXLITE_ORGANIZATION_ID",
	"BOXLITE_REGION_ID", "BOXLITE_TRACEPARENT", "BOXLITE_TRACESTATE",
}

// Native export writes manifest.json first. Replace only that member, then copy
// the raw tar tail unchanged: decoding/re-encoding disk members with Go's tar
// writer would lose GNU sparse metadata. Native import owns all disk validation.
// The plain tar stays beside the download until the restore worker releases it.
func checkpointImportArchive(source *checkpoint.DownloadedArchive, env map[string]string) (_ string, err error) {
	file, err := os.Open(source.Path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	reader := bufio.NewReader(file)
	magic, err := reader.Peek(4)
	if err != nil {
		return "", err
	}
	var input io.Reader = reader
	if bytes.Equal(magic, []byte{0x28, 0xb5, 0x2f, 0xfd}) {
		decoder, err := zstd.NewReader(reader, zstd.WithDecoderConcurrency(1))
		if err != nil {
			return "", err
		}
		defer decoder.Close()
		input = decoder
	}
	headerBytes := make([]byte, 512)
	if _, err := io.ReadFull(input, headerBytes); err != nil {
		return "", err
	}
	header, err := tar.NewReader(bytes.NewReader(headerBytes)).Next()
	if err != nil {
		return "", err
	}
	if header.Name != "manifest.json" || header.Typeflag != tar.TypeReg || header.Size < 0 || header.Size > 1<<20 {
		return "", fmt.Errorf("native checkpoint must begin with a manifest of at most 1 MiB")
	}
	manifest := make([]byte, header.Size)
	if _, err := io.ReadFull(input, manifest); err != nil {
		return "", err
	}
	if _, err := io.CopyN(io.Discard, input, (512-header.Size%512)%512); err != nil {
		return "", err
	}
	manifest, err = checkpointImportManifest(manifest, source.Artifact.PinnedImage, env)
	if err != nil {
		return "", err
	}
	var prefix bytes.Buffer
	writer := tar.NewWriter(&prefix)
	header.Size = int64(len(manifest))
	if err := writer.WriteHeader(header); err != nil {
		return "", err
	}
	if _, err := writer.Write(manifest); err != nil {
		return "", err
	}
	if err := writer.Close(); err != nil {
		return "", err
	}
	output, err := os.CreateTemp(filepath.Dir(source.Path), "import-*.tar")
	if err != nil {
		return "", err
	}
	defer func() {
		err = errors.Join(err, output.Close())
		if err != nil {
			_ = os.Remove(output.Name())
		}
	}()
	// Close appends two zero blocks; the original tail already contains them.
	if _, err := output.Write(prefix.Bytes()[:prefix.Len()-1024]); err != nil {
		return "", err
	}
	if _, err := io.Copy(output, input); err != nil {
		return "", err
	}
	return output.Name(), nil
}

func checkpointImportManifest(data []byte, image string, env map[string]string) ([]byte, error) {
	pinned, err := checkpoint.PinImage(image, "")
	if err != nil {
		return nil, err
	}
	if env["BOXLITE_BOX_ID"] == "" {
		return nil, fmt.Errorf("checkpoint requires a target box ID")
	}
	for key, value := range env {
		if !slices.Contains(checkpointPlatformEnvKeys, key) || strings.ContainsRune(value, 0) {
			return nil, fmt.Errorf("checkpoint platform environment accepts only reserved identity keys")
		}
	}
	var manifest map[string]json.RawMessage
	if err := json.Unmarshal(data, &manifest); err != nil {
		return nil, err
	}
	var options map[string]json.RawMessage
	if err := json.Unmarshal(manifest["box_options"], &options); err != nil || options == nil {
		return nil, fmt.Errorf("checkpoint manifest has no editable box_options")
	}
	var variables [][2]string
	if err := json.Unmarshal(options["env"], &variables); err != nil && len(options["env"]) != 0 {
		return nil, err
	}
	variables = slices.DeleteFunc(variables, func(pair [2]string) bool {
		return slices.Contains(checkpointPlatformEnvKeys, pair[0])
	})
	keys := make([]string, 0, len(env))
	for key := range env {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		variables = append(variables, [2]string{key, env[key]})
	}
	options["env"], _ = json.Marshal(variables)
	options["rootfs"], _ = json.Marshal(map[string]string{"Image": pinned})
	manifest["image"], _ = json.Marshal(pinned)
	manifest["box_options"], err = json.Marshal(options)
	if err != nil {
		return nil, err
	}
	return json.Marshal(manifest)
}
