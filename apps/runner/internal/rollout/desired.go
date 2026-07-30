// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package rollout

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ssm"
)

var sha256Pattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

// DesiredState names the runner build this box should be on. It is written
// only by `sst deploy` (apps/infra/sst.config.ts, RunnerDesiredState) and read
// only here — changing the parameter is what performs a rollout.
//
// GuestSHA256 and RuntimeSuffix are deliberately absent: they live in sidecars
// inside the artifact, which SHA256 already covers. Keeping them out means
// there is one authority for what is in a build (the build itself) rather than
// two that can disagree.
type DesiredState struct {
	Version string `json:"version"`
	URL     string `json:"url"`
	SHA256  string `json:"sha256"`
}

func (d DesiredState) validate() error {
	if d.Version == "" {
		return fmt.Errorf("desired state has no version")
	}
	if d.URL == "" {
		return fmt.Errorf("desired state has no url")
	}
	if !strings.HasPrefix(d.URL, "https://") && !strings.HasPrefix(d.URL, "s3://") {
		return fmt.Errorf("desired state url must be https:// or s3://, got %q", d.URL)
	}
	if !sha256Pattern.MatchString(d.SHA256) {
		return fmt.Errorf("desired state sha256 must be 64 lowercase hex chars, got %q", d.SHA256)
	}
	return nil
}

// ParameterSource reads the desired state from SSM Parameter Store.
type ParameterSource struct {
	client *ssm.Client
	name   string
}

func NewParameterSource(cfg aws.Config, name string) *ParameterSource {
	return &ParameterSource{client: ssm.NewFromConfig(cfg), name: name}
}

func (s *ParameterSource) Get(ctx context.Context) (DesiredState, error) {
	out, err := s.client.GetParameter(ctx, &ssm.GetParameterInput{Name: aws.String(s.name)})
	if err != nil {
		return DesiredState{}, fmt.Errorf("read desired state from %s: %w", s.name, err)
	}
	if out.Parameter == nil || out.Parameter.Value == nil {
		return DesiredState{}, fmt.Errorf("desired state parameter %s is empty", s.name)
	}

	var desired DesiredState
	if err := json.Unmarshal([]byte(*out.Parameter.Value), &desired); err != nil {
		return DesiredState{}, fmt.Errorf("parse desired state from %s: %w", s.name, err)
	}
	if err := desired.validate(); err != nil {
		return DesiredState{}, fmt.Errorf("%s: %w", s.name, err)
	}
	return desired, nil
}

// InstalledState records what the last successful reconcile actually put on
// disk. It is what makes a repeated reconcile a no-op: without it the agent
// would have to re-derive the installed build by hashing files on every timer
// tick, and would still not know which artifact they came from.
type InstalledState struct {
	Version       string `json:"version"`
	SHA256        string `json:"sha256"`
	GuestSHA256   string `json:"guestSha256"`
	RuntimeSuffix string `json:"runtimeSuffix"`
	ReleaseDir    string `json:"releaseDir"`
}

func (i InstalledState) matches(d DesiredState) bool {
	return i.Version == d.Version && i.SHA256 == d.SHA256
}
