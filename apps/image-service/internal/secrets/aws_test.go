// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package secrets

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/secretsmanager"
)

type awsReadFake struct {
	calls []*secretsmanager.GetSecretValueInput
	value *secretsmanager.GetSecretValueOutput
	err   error
}

func (f *awsReadFake) GetSecretValue(_ context.Context, input *secretsmanager.GetSecretValueInput, _ ...func(*secretsmanager.Options)) (*secretsmanager.GetSecretValueOutput, error) {
	f.calls = append(f.calls, input)
	return f.value, f.err
}

func TestAWSReadsPinnedRegistrySecretVersion(t *testing.T) {
	id := "00000000-0000-4000-8000-000000000001"
	prefix := "registry-credential-boxlite-app-dev-"
	arn := "arn:aws:secretsmanager:us-east-1:123456789012:secret:" + prefix + id + "-A1b2C3"
	client := &awsReadFake{value: &secretsmanager.GetSecretValueOutput{SecretString: aws.String("password")}}
	reader := &awsSecretManager{client: client, scope: awsSecretScope{"us-east-1", "123456789012", prefix}}
	value, err := reader.Read(context.Background(), arn+"/versions/"+id)
	if err != nil || value != "password" {
		t.Fatalf("Read = %q, %v", value, err)
	}
	if len(client.calls) != 1 || *client.calls[0].SecretId != arn || *client.calls[0].VersionId != id {
		t.Fatalf("the SDK request did not pin the assigned version: %+v", client.calls)
	}
}

func TestAWSRejectsForeignRegistryVersionsBeforeReading(t *testing.T) {
	id := "00000000-0000-4000-8000-000000000001"
	prefix := "registry-credential-boxlite-app-dev-"
	version := "arn:aws:secretsmanager:us-east-1:123456789012:secret:" + prefix + id + "-A1b2C3/versions/" + id
	for _, reference := range []string{
		strings.Replace(version, "123456789012", "999999999999", 1),
		strings.Replace(version, "us-east-1", "us-west-2", 1),
		strings.Replace(version, "boxlite-app-dev-", "boxlite-app-prod-", 1),
		strings.Replace(version, "/versions/"+id, "/versions/00000000-0000-4000-8000-000000000002", 1),
		"projects/project/secrets/name/versions/1", "../password",
	} {
		client := &awsReadFake{}
		reader := &awsSecretManager{client: client, scope: awsSecretScope{"us-east-1", "123456789012", prefix}}
		if _, err := reader.Read(context.Background(), reference); !errors.Is(err, ErrInvalidVersion) {
			t.Errorf("%q: got %v", reference, err)
		}
		if len(client.calls) != 0 {
			t.Errorf("foreign reference reached AWS: %q", reference)
		}
	}
}

func TestAWSRegistryReadFailuresStayFailures(t *testing.T) {
	id := "00000000-0000-4000-8000-000000000001"
	prefix := "registry-credential-boxlite-app-dev-"
	version := "arn:aws:secretsmanager:us-east-1:123456789012:secret:" + prefix + id + "-A1b2C3/versions/" + id
	client := &awsReadFake{err: errors.New("permission denied")}
	reader := &awsSecretManager{client: client, scope: awsSecretScope{"us-east-1", "123456789012", prefix}}
	if _, err := reader.Read(context.Background(), version); err == nil || !strings.Contains(err.Error(), "permission denied") {
		t.Fatalf("permission failure disappeared: %v", err)
	}
	client.err = nil
	for _, response := range []*secretsmanager.GetSecretValueOutput{
		nil, {}, {SecretString: aws.String(strings.Repeat("x", payloadLimit+1))},
	} {
		client.value = response
		if _, err := reader.Read(context.Background(), version); err == nil {
			t.Fatal("an absent or oversized password was accepted")
		}
	}
}

func TestAWSRegistryNeedsCompleteScope(t *testing.T) {
	t.Setenv("AWS_REGION", "us-east-1")
	t.Setenv("REGISTRY_SECRET_ACCOUNT_ID", "123456789012")
	t.Setenv("REGISTRY_SECRET_PREFIX", "")
	if _, err := NewReader(context.Background(), "aws", ""); err == nil {
		t.Fatal("incomplete AWS scope was accepted")
	}
}
