// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/google/uuid"
)

const protectedProcessFile = "/run/boxlite-runner/protected-process.json"

type protectedProcessIdentity struct {
	PID              int    `json:"pid"`
	StartTicks       uint64 `json:"start_ticks"`
	ID               string `json:"process_id"`
	ExecutableDigest string `json:"executable_digest"`
}

func publishProtectedProcessIdentity() (protectedProcessIdentity, error) {
	executable, err := os.Open("/proc/self/exe")
	if err != nil {
		return protectedProcessIdentity{}, err
	}
	defer executable.Close()
	digest := sha256.New()
	if _, err := io.Copy(digest, executable); err != nil {
		return protectedProcessIdentity{}, err
	}
	stat, err := os.ReadFile("/proc/self/stat")
	if err != nil {
		return protectedProcessIdentity{}, err
	}
	startTicks, err := processStartTicks(string(stat))
	if err != nil {
		return protectedProcessIdentity{}, err
	}
	identity := protectedProcessIdentity{
		PID: os.Getpid(), StartTicks: startTicks, ID: uuid.NewString(),
		ExecutableDigest: hex.EncodeToString(digest.Sum(nil)),
	}
	directory := filepath.Dir(protectedProcessFile)
	if err := os.MkdirAll(directory, 0700); err != nil {
		return protectedProcessIdentity{}, err
	}
	file, err := os.CreateTemp(directory, "protected-process-*.json")
	if err != nil {
		return protectedProcessIdentity{}, err
	}
	defer os.Remove(file.Name())
	if err := json.NewEncoder(file).Encode(identity); err != nil {
		_ = file.Close()
		return protectedProcessIdentity{}, err
	}
	if err := file.Close(); err != nil {
		return protectedProcessIdentity{}, err
	}
	if err := os.Rename(file.Name(), protectedProcessFile); err != nil {
		return protectedProcessIdentity{}, err
	}
	return identity, nil
}

func processStartTicks(stat string) (uint64, error) {
	end := strings.LastIndex(stat, ") ")
	if end == -1 {
		return 0, fmt.Errorf("process stat has no command boundary")
	}
	// The fields after the command start at field 3. Start time is field 22.
	fields := strings.Fields(stat[end+2:])
	if len(fields) < 20 {
		return 0, fmt.Errorf("process stat has no start time")
	}
	return strconv.ParseUint(fields[19], 10, 64)
}
