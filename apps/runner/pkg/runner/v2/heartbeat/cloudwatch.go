// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

package heartbeat

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/cloudwatch"
	"github.com/aws/aws-sdk-go-v2/service/cloudwatch/types"
)

const (
	runnerHealthyMetric    = "RunnerHealthy"
	minimumPublishInterval = 30 * time.Second
	maximumPublishInterval = 2 * time.Minute
)

type Publisher interface {
	Publish(ctx context.Context, healthy bool) error
}

type cloudWatchAPI interface {
	PutMetricData(
		ctx context.Context,
		params *cloudwatch.PutMetricDataInput,
		optFns ...func(*cloudwatch.Options),
	) (*cloudwatch.PutMetricDataOutput, error)
}

type CloudWatchConfig struct {
	Namespace string
	Stage     string
	Region    string
	Runner    string
	Interval  time.Duration
	Client    cloudWatchAPI
	Now       func() time.Time
}

type cloudWatchPublisher struct {
	namespace     string
	stage         string
	region        string
	runner        string
	interval      time.Duration
	client        cloudWatchAPI
	now           func() time.Time
	mu            sync.Mutex
	lastPublished time.Time
	hasPublished  bool
	lastHealthy   bool
}

func NewCloudWatchPublisher(ctx context.Context, cfg CloudWatchConfig) (Publisher, error) {
	if cfg.Namespace == "" && cfg.Stage == "" && cfg.Runner == "" {
		return nil, nil
	}
	if cfg.Namespace == "" || cfg.Stage == "" || cfg.Region == "" || cfg.Runner == "" {
		return nil, fmt.Errorf("status heartbeat namespace, stage, region, and runner are required together")
	}
	if cfg.Interval < minimumPublishInterval || cfg.Interval >= maximumPublishInterval {
		return nil, fmt.Errorf("status heartbeat interval must be at least 30 seconds and less than 2 minutes")
	}

	client := cfg.Client
	if client == nil {
		awsCfg, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(cfg.Region))
		if err != nil {
			return nil, fmt.Errorf("load AWS configuration for status heartbeat: %w", err)
		}
		client = cloudwatch.NewFromConfig(awsCfg)
	}
	now := cfg.Now
	if now == nil {
		now = time.Now
	}

	return &cloudWatchPublisher{
		namespace: cfg.Namespace,
		stage:     cfg.Stage,
		region:    cfg.Region,
		runner:    cfg.Runner,
		interval:  cfg.Interval,
		client:    client,
		now:       now,
	}, nil
}

func (p *cloudWatchPublisher) Publish(ctx context.Context, healthy bool) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	now := p.now().UTC()
	if p.hasPublished && healthy == p.lastHealthy && now.Sub(p.lastPublished) < p.interval {
		return nil
	}

	value := 0.0
	if healthy {
		value = 1
	}
	_, err := p.client.PutMetricData(ctx, &cloudwatch.PutMetricDataInput{
		Namespace: aws.String(p.namespace),
		MetricData: []types.MetricDatum{
			{
				MetricName: aws.String(runnerHealthyMetric),
				Timestamp:  aws.Time(now),
				Unit:       types.StandardUnitCount,
				Value:      aws.Float64(value),
				Dimensions: []types.Dimension{
					{Name: aws.String("Stage"), Value: aws.String(p.stage)},
					{Name: aws.String("Region"), Value: aws.String(p.region)},
					{Name: aws.String("Runner"), Value: aws.String(p.runner)},
				},
			},
		},
	})
	if err != nil {
		return fmt.Errorf("publish Runner status heartbeat: %w", err)
	}
	p.lastPublished = now
	p.hasPublished = true
	p.lastHealthy = healthy
	return nil
}
