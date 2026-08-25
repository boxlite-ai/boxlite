// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

package heartbeat

import (
	"context"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/cloudwatch"
)

type fakeCloudWatch struct {
	inputs []*cloudwatch.PutMetricDataInput
	err    error
}

func (f *fakeCloudWatch) PutMetricData(
	_ context.Context,
	input *cloudwatch.PutMetricDataInput,
	_ ...func(*cloudwatch.Options),
) (*cloudwatch.PutMetricDataOutput, error) {
	f.inputs = append(f.inputs, input)
	return &cloudwatch.PutMetricDataOutput{}, f.err
}

func TestCloudWatchPublisherUsesBoundedPublicDimensions(t *testing.T) {
	now := time.Date(2026, 8, 25, 0, 0, 0, 0, time.UTC)
	client := &fakeCloudWatch{}
	publisher, err := NewCloudWatchPublisher(context.Background(), CloudWatchConfig{
		Namespace: "BoxLite/PublicStatus",
		Stage:     "prod",
		Region:    "ap-southeast-1",
		Runner:    "runner-1",
		Interval:  time.Minute,
		Client:    client,
		Now:       func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}

	if err := publisher.Publish(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	if err := publisher.Publish(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	if len(client.inputs) != 1 {
		t.Fatalf("expected the second heartbeat to be throttled, got %d writes", len(client.inputs))
	}

	input := client.inputs[0]
	if aws.ToString(input.Namespace) != "BoxLite/PublicStatus" {
		t.Fatalf("unexpected namespace %q", aws.ToString(input.Namespace))
	}
	metric := input.MetricData[0]
	if aws.ToString(metric.MetricName) != runnerHealthyMetric || aws.ToFloat64(metric.Value) != 1 {
		t.Fatalf("unexpected heartbeat metric: %#v", metric)
	}
	if len(metric.Dimensions) != 3 {
		t.Fatalf("expected bounded Stage/Region/Runner dimensions, got %#v", metric.Dimensions)
	}

	if err := publisher.Publish(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	if len(client.inputs) != 2 || aws.ToFloat64(client.inputs[1].MetricData[0].Value) != 0 {
		t.Fatalf("expected a state change to publish immediately, got %#v", client.inputs)
	}

	if err := publisher.Publish(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	if len(client.inputs) != 2 {
		t.Fatalf("expected repeated unhealthy heartbeat to be throttled, got %d writes", len(client.inputs))
	}
	now = now.Add(time.Minute)
	if err := publisher.Publish(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	if len(client.inputs) != 3 {
		t.Fatalf("expected the unhealthy heartbeat to refresh after the interval, got %d writes", len(client.inputs))
	}
}

func TestCloudWatchPublisherIsOptionalButRejectsPartialConfiguration(t *testing.T) {
	publisher, err := NewCloudWatchPublisher(context.Background(), CloudWatchConfig{})
	if err != nil || publisher != nil {
		t.Fatalf("empty heartbeat configuration should disable publishing: publisher=%#v err=%v", publisher, err)
	}

	_, err = NewCloudWatchPublisher(context.Background(), CloudWatchConfig{
		Namespace: "BoxLite/PublicStatus",
		Stage:     "prod",
		Interval:  time.Minute,
	})
	if err == nil {
		t.Fatal("partial heartbeat configuration must fail")
	}
}
