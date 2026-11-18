// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package secrets

import (
	"context"
	"fmt"
	"os"
	"regexp"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/secretsmanager"
)

type awsSecretClient interface {
	GetSecretValue(context.Context, *secretsmanager.GetSecretValueInput, ...func(*secretsmanager.Options)) (*secretsmanager.GetSecretValueOutput, error)
}

type awsSecretScope struct{ region, account, prefix string }
type awsSecretManager struct {
	client awsSecretClient
	scope  awsSecretScope
}

var awsVersion = regexp.MustCompile(`^(arn:aws:secretsmanager:([a-z0-9-]+):([0-9]{12}):secret:([A-Za-z0-9_-]+))/versions/([0-9a-f-]{36})$`)
var storageUUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
var secretSuffix = regexp.MustCompile(`^[A-Za-z0-9]{6}$`)

func newAWSSecretManager(ctx context.Context) (*awsSecretManager, error) {
	scope := awsSecretScope{os.Getenv("AWS_REGION"), os.Getenv("REGISTRY_SECRET_ACCOUNT_ID"), os.Getenv("REGISTRY_SECRET_PREFIX")}
	if !regexp.MustCompile(`^[a-z]{2}-[a-z0-9-]+-[0-9]+$`).MatchString(scope.region) ||
		!regexp.MustCompile(`^[0-9]{12}$`).MatchString(scope.account) ||
		!regexp.MustCompile(`^registry-credential-[A-Za-z0-9_-]+-$`).MatchString(scope.prefix) {
		return nil, fmt.Errorf("AWS registry secrets require a region, account ID and stage credential prefix")
	}
	cfg, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(scope.region))
	if err != nil {
		return nil, fmt.Errorf("configure AWS registry secret reader: %w", err)
	}
	return &awsSecretManager{client: secretsmanager.NewFromConfig(cfg), scope: scope}, nil
}

func (s *awsSecretManager) Read(ctx context.Context, version string) (string, error) {
	match := awsVersion.FindStringSubmatch(version)
	if len(match) != 6 || match[2] != s.scope.region || match[3] != s.scope.account ||
		!strings.HasPrefix(match[4], s.scope.prefix) {
		return "", ErrInvalidVersion
	}
	tail := strings.TrimPrefix(match[4], s.scope.prefix)
	if len(tail) < 7 {
		return "", ErrInvalidVersion
	}
	id, suffix := tail[:len(tail)-7], tail[len(tail)-6:]
	if tail[len(tail)-7] != '-' || !storageUUID.MatchString(id) || !secretSuffix.MatchString(suffix) || match[5] != id {
		return "", ErrInvalidVersion
	}
	ctx, cancel := context.WithTimeout(ctx, secretManagerTimeout)
	defer cancel()
	value, err := s.client.GetSecretValue(ctx, &secretsmanager.GetSecretValueInput{
		SecretId: aws.String(match[1]), VersionId: aws.String(match[5]),
	})
	if err != nil {
		return "", fmt.Errorf("read AWS registry secret: %w", err)
	}
	if value == nil || value.SecretString == nil || len(*value.SecretString) > payloadLimit {
		return "", fmt.Errorf("AWS registry secret returned no bounded string payload")
	}
	return *value.SecretString, nil
}
